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
2. Read all messages provided in JSON format. Due to the character limit, focus on summarising only the most important and contextually relevant information.
3. If the user has asked a question, answer it using only information from the messages.
4. If there is no question, only provide a summary. Do not mention the absence of a question.
5. The summary must be detailed, informative, and under 1800 characters.

### Mentions:
5. If a message includes a **user mention** (starts with \`<@\`), and that user is contextually important, you **must include the mention exactly as written** (e.g. \`<@123456789>\`).
6. If a message includes a **role mention** (starts with \`<@&\`), and the role is contextually important, you **must include the mention exactly as written** (e.g. \`<@&987654321>\`).
7. Do not replace mentions with display names or role names. Keep the raw Discord mention syntax.

### Source Message Links:
8. **Every bullet point must include a source link to the original message it summarises.**
9. Use this exact markdown format for the source link:
   \`[source](https://discord.com/channels/guild_id/channel_id/message_id)\`
   - Replace \`guild_id\`, \`channel_id\`, and \`message_id\` with the correct values.
   - Use the link alias \`source\` exactly. Do not use other words or change its text.

### Output Format:
10. Return the summary in Markdown format using bullet points (\`-\`).
11. Do not include a blank new line between bullet points.
12. Ensure the bullet points are in choronological order of their source messages, from newest to oldest.
13. Include the corresponding \`[source]\` link **in every bullet point** — usually at the end.
14. You must not return more than 2000 characters under any circumstance. If the response would exceed this, truncate or summarise further.
15. Do not make up or assume facts. State only what is evident from the messages.

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
				.setMinValue(1)
				.setMaxValue(1000)
				.addChoices(
					{ name: '50', value: 50 },
					{ name: '100', value: 100 },
					{ name: '200', value: 200 },
					{ name: '500', value: 500 },
					{ name: '1000', value: 1000 }
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
			const messageContent = messages.map(msg => {
				return {
					message_id: msg.id,
					content: msg.content,
					timestamp: msg.createdTimestamp,
				}});	

			const userPrompt = `
Here is additional context for your task:

- Messages are provided below in JSON format.
- guild_id: ${channel.guild.id}
- channel_id: ${channel.id}
- current user's user_id: ${currentUser.id}

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
			
			let summary = summaryResponse.choices[0].message.content;
			let footerText = prompt ? `Prompt: ${prompt}` : 'No prompt provided.';
			
			// Discord has max response length restrictions
			if (summary.length > maxResponseLength) {
				footerText += ` Response truncated by ${summary.length - maxResponseLength} chars.`;
				summary = summary.slice(0, maxResponseLength);
			}

			// Return an embed
			const summaryEmbed = {
				color: embedColor, 
				title: `Summarised ${messages.length} Messages`,
				description: summary,
				footer: {
					text: footerText,
				},
			};

			await interaction.editReply({ content: `Summarised ${messages.length} messages.` });
			
			if (visibility === 'private') {
				await interaction.editReply({ embeds: [summaryEmbed] });
			} else {
				// Send a follow-up message so it's public
				await interaction.followUp({ embeds: [summaryEmbed], ephemeral: false });
			}
			
		} catch (error) {
			console.error('Error summarising messages:', error);
			await interaction.editReply({ content: 'An error occurred while processing your request.' });
		}
	},
};
