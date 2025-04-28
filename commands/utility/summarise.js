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
4. Due to the character limit, focus on summarising only the most important and contextually relevant information.
5. If the user has asked a question, answer it using only information from the messages.
6. If there is no question, only provide a summary. Do not mention the absence of a question.
7. The summary must be detailed, informative, and under 2000 characters.

### Handling Timestamps:
8. Messages include a \`timestamp\` field (ISO 8601 UTC format).
9. Take timestamps into account when interpreting the conversation:
   - Notice significant time gaps (e.g., replies days later).
   - Reflect important timing in the summary if relevant (e.g., "After several days..." or "Later that same day...").
   - Consider today's date when interpreting how recent or old messages are.
   - Maintain the chronological order based on timestamps, from newest to oldest.

### Mentions:
10. If a message includes a **user mention** (starts with \`<@\`), and that user is contextually important, you **must include the mention exactly as written** (e.g., \`<@123456789>\`).
11. If a message includes a **role mention** (starts with \`<@&\`), and that role is contextually important, you **must include the mention exactly as written** (e.g., \`<@&987654321>\`).
12. Do not replace mentions with display names or role names. Keep the raw Discord mention syntax.

### Source Message Links:
13. Each sentence that summarises information from a message **must** have its own \`[source]\` link immediately at the end of that sentence.
14. Do not group multiple sources at the end of the bullet point; attach the \`[source]\` link immediately after the specific sentence it supports.
15. If a sentence summarises multiple messages, you may list multiple \`[source]\` links after that sentence.
16. Ignore trivial or non-informative messages (e.g., "ok", "yes", "but") unless they are essential to understanding the main idea.
17. Use this exact markdown format for each source link:
   \`[source](https://discord.com/channels/guild_id/channel_id/message_id)\`
   - Replace \`guild_id\`, \`channel_id\`, and \`message_id\` with the correct values.
   - Use the link alias \`source\` exactly. Do not use other words or change its text.

### Output Format:
18. Return the summary in Markdown format using bullet points (\`-\`).
19. Do not include blank new lines between bullet points.
20. Ensure the bullet points are ordered from newest to oldest based on the timestamps.
21. Insert \`[source]\` links immediately after the specific sentence or information they support.
22. You must not return more than 2000 characters under any circumstance. If the response would exceed this, truncate or summarise further.

### Natural Language:
23. Write the summary in natural, fluent English, as if explaining the conversation to a human reader.
24. Do not mention or reference technical details such as Discord IDs, user IDs, channel IDs, message IDs, timestamps, snowflakes, or API structures.
25. Focus only on the content, meaning, and intent of the conversation, not its technical underpinnings.
26. If something is uncertain or ambiguous, simply summarise what is known without guessing or speculating about technical metadata.
27. Maintain a professional but natural tone throughout the summary.

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
				// Get author server alias
				const author = await msg.guild.members.fetch(msg.author.id);
				const nickname = author.nickname || author.user.username;

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
			}
		} catch (error) {
			console.error('Error summarising messages:', error);
			await interaction.editReply({ content: 'An error occurred while processing your request.' });
		}
	},
};
