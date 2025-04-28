const { SlashCommandBuilder, time } = require('discord.js');
const OpenAI = require("openai");
const dotenv = require('dotenv');

dotenv.config();

const maxResponseLength = 4096;

const embedColor = 0x9656ce;

const systemPrompt = `
You are a helpful assistant generating Discord message summaries.

### Your Task:
1. Summarise the provided messages clearly and concisely.
2. Read all messages provided in JSON format. Each message includes a timestamp in ISO 8601 format (UTC).
3. Today's date is ${new Date().toISOString().split('T')[0]} (in UTC).
4. Because of the character limit, focus on the most important and contextually relevant information.
5. If the user has asked a question:
   a. Answer it using **only** information from the messages.  
   b. **Return only content directly relevant to the question; omit unrelated details.**
6. If **no** question is given, provide a **brief** summary that captures only the most important updates or decisions—keep it easy to read at a glance.  
   **Split distinct topics into separate bullets, and aim for bullets no longer than one or two short sentences.**

### Handling Timestamps:
7. Messages include a \`timestamp\` field (ISO 8601 UTC format).
8. Take timestamps into account when interpreting the conversation:
   - Notice significant time gaps (e.g., replies days later).
   - Reflect important timing in the summary if relevant (e.g., “After several days…” or “Later that same day…”).
   - Consider today’s date when interpreting how recent or old messages are.
   - Maintain chronological order based on timestamps, from newest to oldest.

### Mentions:
9. **Always prefer raw Discord mentions when referring to participants who appear in the messages.**
   - If a user mention (starts with \`<@\`) is contextually relevant, include it exactly as written.
   - If a role mention (starts with \`<@&\`) is contextually relevant, include it exactly as written.
10. Do not replace mentions with display names or role names.
11. When a mention is used, **do not also append the user’s nickname or role in brackets**.

### Source Message Links:
12. Each sentence that summarises information from the messages **should** have at least one supporting \`[source]\` link, but **limit to the most important sources (ideally ≤ 3 per bullet)**.
13. Attach the \`[source]\` link(s) immediately after the sentence they support. If a sentence draws on multiple messages, list multiple links right after it, separated by commas with spaces.
14. Ignore trivial or non-informative messages (e.g., “ok”, “yes”) unless essential to the main idea.
15. Use this exact markdown format for each link:  
   \`[source](https://discord.com/channels/guild_id/channel_id/message_id)\`
   - Replace \`guild_id\`, \`channel_id\`, and \`message_id\` with the correct values.
   - Use the link alias **source** exactly.

### Output Format:
16. Return the result in Markdown bullet points (\`-\`).
17. Do not include blank lines between bullet points.
18. **Each bullet must cover only one closely related idea or decision.** If messages discuss multiple topics, create multiple bullets. Keep each bullet concise (ideally ≤ 2 sentences).
19. Order bullets from newest to oldest by timestamp.
20. Insert \`[source]\` links immediately after the sentence(s) they support.
21. Never exceed 2000 characters—truncate or compress further if necessary.

### Natural Language:
22. Write in clear, fluent British English suitable for a human reader.
23. Do not mention technical details such as IDs, snowflakes, timestamps, or API structures.
24. Focus only on the content, meaning, and intent of the conversation—not its technical underpinnings.
25. If something is uncertain or ambiguous, summarise what is known without guessing.
26. Maintain a professional yet natural tone throughout.

Strictly follow these instructions.`;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

module.exports = {
	data: new SlashCommandBuilder()
		.setName('summarise')
		.setDescription('Summarise messages in this channel')
		.addStringOption(option =>
			option
				.setName('ask')
				.setDescription('Specific questions to ask')
		)
		.addIntegerOption(option =>
			option
				.setName('limit')
				.setDescription('The maximum number of messages to read')
				.addChoices(
					{ name: '50', value: 50 },
					{ name: '100', value: 100 },
					{ name: '200', value: 200 },
					{ name: '500', value: 500 },
					{ name: '1000', value: 1000 },
					{ name: '2000', value: 2000 }
				)
		)
		.addStringOption(option =>
			option
				.setName('visibility')
				.setDescription('Choose who can see the AI response')
				.addChoices(
					{ name: 'You', value: 'private' },
					{ name: 'Everyone', value: 'public' }
				)
		),
	async execute(interaction) {
		if (!interaction.inGuild()) {
			// Cannot use this command in DMs
			return await interaction.reply({
				content: '❌ You cannot use this command in DMs.'
			});
		}

		await interaction.deferReply({ ephemeral: true });
		await interaction.editReply({ content: 'Processing request...' });

		const prompt = interaction.options.getString('ask');
		const messageLimit = interaction.options.getInteger('limit') || 50
		const visibility = interaction.options.getString('visibility') || 'private';

		try {
			const currentUser = interaction.user;

			// Get the channel
			const channel = interaction.channel ?? await interaction.client.channels.fetch(interaction.channelId);

			// Check if channel is text-based and supports messages
			if (!channel.isTextBased?.() || !channel.messages) {
				return interaction.editReply({ content: 'This command only works in text-based channels.' });
			}

			let fetchedMessages = [];
			let lastMessageId = null;

			// Per Discord constraints, fetch messages in batches of 100 until we reach the limit
			while (fetchedMessages.length < messageLimit) {
				
				const remaining = messageLimit - fetchedMessages.length;
				const fetchLimit = remaining > 100 
				? 100 
				: remaining;
				
				const options = {
					limit: fetchLimit
				};

				await interaction.editReply({ content: `Fetching messages... (possibly ${remaining} remaining)` });
				
				// Fetch from where we left off
				if (lastMessageId) {
					options.before = lastMessageId;
				}
				
				const batch = await channel.messages.fetch(options);
				if (batch.size === 0) break;
				
				fetchedMessages = fetchedMessages.concat(Array.from(batch.values()));
				lastMessageId = batch.last().id;
			}

			const messages = fetchedMessages;
			const messageContent = []
			
			for (const msg of messages) {
				let nickname;

				try {
					const author = await msg.guild.members.fetch(msg.author.id);
					nickname = author.nickname || author.user.username;
				} catch (error) {
					// Fallback if member is not found (i.e. left the server)
					nickname = msg.author.username;
				}

				messageContent.push({
					message_id: msg.id,
					content: msg.content,
					authorUserId: `<@${msg.author.id}>`,
					authorNickname: nickname,
					timestamp: new Date(msg.createdTimestamp).toISOString(),
				});
			}

			// Reverse the messages so GPT reads them in chronological order
			messageContent.reverse();

			const userPrompt = `
Here is additional context for your task:

- Messages are provided below in JSON format.
- Each message includes a \`timestamp\` field in ISO 8601 UTC format.
- Important IDs for constructing source links:
  - \`guild_id\`: ${channel.guild.id}
  - \`channel_id\`: ${channel.id}
- These IDs are not included in the messages themselves. Use these values when creating source links.
- Additional information (for context only):
  - Guild name: ${channel.guild.name}
  - Channel name: ${channel.name}
  - Current user's ID: <@${currentUser.id}>
  - Current user's server nickname: ${currentUser.nickname || currentUser.username}

Messages:
${JSON.stringify(messageContent)}

Question:
${prompt || 'No additional question provided.'}
`;

			await interaction.editReply({ content: 'Summarising messages...' });

			const summaryResponse = await openai.chat.completions.create({
				model: 'gpt-4.1-mini',
				messages: [
					{ role: 'system', content: systemPrompt },
					{ role: 'user', content: userPrompt }
				],
				temperature: 0,
				max_tokens: 5000,
			});
			
			// GPT response
			let summary = summaryResponse.choices[0].message.content;

			await interaction.editReply({ content: `Summarised ${messages.length} messages.` });
			await interaction.user.send(`Summarised ${messages.length} messages in <#${channel.id}>.`);

			// Split the summary into chunks if it exceeds the max response length
			const splitSummary = [];
			while (summary.length > maxResponseLength) {
				splitSummary.push(summary.slice(0, maxResponseLength));
				summary = summary.slice(maxResponseLength);
			}

			// Add remaning summary if any
			if (summary.length > 0) {
				splitSummary.push(summary);
			}

			let promptMessage = prompt ? `Prompt: ${prompt}` : 'No prompt provided.';

			for (let i = 0; i < splitSummary.length; i++) {
				// Return embeds
				const summaryEmbed = {
					color: embedColor, 
					title: `Summarised ${messages.length} Messages`,
					description: splitSummary[i],
					footer: {
						text: promptMessage + `\nPage ${i + 1} of ${splitSummary.length}.`
					},
				};

				await interaction.followUp({ embeds: [summaryEmbed], ephemeral: visibility === 'private' });
				await interaction.user.send({ embeds: [summaryEmbed] });
			}
		} catch (error) {
			console.error('Error summarising messages:', error);
			await interaction.editReply({ content: 'An error occurred while processing your request.' });
		}
	},
};
