import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import Discord from "discord.js";
import db from "./loadDatabase.js";
import discordTranscripts from "discord-html-transcripts";

const dbGet = (query, params = []) => new Promise((resolve, reject) => {
	db.get(query, params, (err, row) => {
		if (err) return reject(err);
		resolve(row);
	});
});

const dbRun = (query, params = []) => new Promise((resolve, reject) => {
	db.run(query, params, function (err) {
		if (err) return reject(err);
		resolve(this);
	});
});

const isEntretienStaff = (member, settings) => {
	return Boolean(member && settings?.staffRole && member.roles.cache.has(settings.staffRole));
};

const canEditEntretienConfig = async (interaction, config) => {
	const settings = await dbGet('SELECT * FROM entretien WHERE guild = ?', [interaction.guild.id]).catch(() => null);
	return config.owners.includes(interaction.user.id)
		|| interaction.member.permissions.has(Discord.PermissionFlagsBits.Administrator)
		|| isEntretienStaff(interaction.member, settings);
};

const sendDm = async (user, content) => {
	await user.send(content).catch(() => { });
};

const getOpenEntretienTicket = async (guildId, channelId) => {
	return dbGet(
		"SELECT * FROM entretien_tickets WHERE guild = ? AND channelId = ? AND status = 'open'",
		[guildId, channelId]
	);
};

const escapeHtml = value => String(value || '')
	.replace(/&/g, '&amp;')
	.replace(/</g, '&lt;')
	.replace(/>/g, '&gt;')
	.replace(/"/g, '&quot;')
	.replace(/'/g, '&#039;');

const fetchAllMessages = async channel => {
	const messages = [];
	let before;

	while (true) {
		const fetched = await channel.messages.fetch({ limit: 100, before });
		if (fetched.size === 0) break;

		messages.push(...fetched.values());
		before = fetched.last().id;
		if (fetched.size < 100) break;
	}

	return messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
};

const createSimpleTranscript = async (channel, filename) => {
	const messages = await fetchAllMessages(channel);
	const rows = messages.map(message => {
		const attachments = message.attachments.size > 0
			? `<div class="attachments">${message.attachments.map(attachment => `<a href="${escapeHtml(attachment.url)}">${escapeHtml(attachment.name || attachment.url)}</a>`).join('<br>')}</div>`
			: '';
		const embeds = message.embeds.length > 0
			? `<div class="embeds">${message.embeds.map(embed => `<pre>${escapeHtml(JSON.stringify(embed.toJSON?.() || embed.data || {}, null, 2))}</pre>`).join('')}</div>`
			: '';

		return `
			<article class="message">
				<img src="${escapeHtml(message.author.displayAvatarURL())}" alt="">
				<div>
					<header>
						<strong>${escapeHtml(message.author.tag)}</strong>
						<span>${new Date(message.createdTimestamp).toLocaleString('fr-FR')}</span>
					</header>
					<p>${escapeHtml(message.content).replace(/\n/g, '<br>') || '<em>Aucun contenu texte</em>'}</p>
					${attachments}
					${embeds}
				</div>
			</article>`;
	}).join('\n');

	const html = `<!doctype html>
<html lang="fr">
<head>
	<meta charset="utf-8">
	<title>Transcript ${escapeHtml(channel.name)}</title>
	<style>
		body { background: #313338; color: #dbdee1; font-family: Arial, sans-serif; margin: 0; padding: 24px; }
		h1 { color: #fff; font-size: 22px; margin: 0 0 8px; }
		.meta { color: #b5bac1; margin-bottom: 24px; }
		.message { display: flex; gap: 12px; border-top: 1px solid #3f4147; padding: 14px 0; }
		img { width: 40px; height: 40px; border-radius: 50%; }
		header { display: flex; gap: 10px; align-items: baseline; }
		header span { color: #949ba4; font-size: 12px; }
		p { margin: 6px 0; white-space: normal; }
		a { color: #00a8fc; }
		pre { background: #2b2d31; border-radius: 6px; overflow: auto; padding: 10px; }
		.attachments, .embeds { margin-top: 8px; }
	</style>
</head>
<body>
	<h1>#${escapeHtml(channel.name)}</h1>
	<div class="meta">${messages.length} message(s) exporte(s)</div>
	${rows || '<p>Aucun message trouve.</p>'}
</body>
</html>`;

	return new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: filename });
};

const closeEntretien = async (interaction, ticket, settings, accepted) => {
	const guild = interaction.guild;
	const channel = interaction.channel;
	const member = await guild.members.fetch(ticket.userId).catch(() => null);

	if (!member) {
		return interaction.reply({
			content: "Impossible de retrouver le membre lie a cet entretien.",
			flags: Discord.MessageFlags.Ephemeral
		});
	}

	const targetRoleId = accepted ? settings.acceptRole : settings.denyRole;
	const missing = [];

	if (!targetRoleId || !guild.roles.cache.has(targetRoleId)) {
		missing.push(accepted ? 'role accepte' : 'role refuse');
	}
	if (!settings.logChannel || !guild.channels.cache.has(settings.logChannel)) {
		missing.push('salon de logs');
	}

	if (missing.length > 0) {
		return interaction.reply({
			content: `Configuration incomplete: ${missing.join(', ')}.`,
			flags: Discord.MessageFlags.Ephemeral
		});
	}

	await interaction.deferReply({ flags: Discord.MessageFlags.Ephemeral });
	await member.roles.add(targetRoleId);

	const resultText = accepted ? 'accepte' : 'refuse';
	const logChannel = guild.channels.cache.get(settings.logChannel);
	const embed = new EmbedBuilder()
		.setTitle(`Entretien ${resultText}`)
		.setDescription(`${member} (${member.user.tag})`)
		.addFields(
			{ name: 'Staff', value: `${interaction.user}`, inline: true },
			{ name: 'Salon', value: channel.name, inline: true }
		)
		.setColor(accepted ? 0x57F287 : 0xED4245)
		.setTimestamp();

	let transcript = null;
	let transcriptFailed = false;

	try {
		transcript = await discordTranscripts.createTranscript(channel, {
			limit: -1,
			returnType: "attachment",
			filename: `entretien-${member.user.username}-${channel.id}.html`
		});
	} catch (error) {
		console.error("Erreur lors de la creation du transcript entretien:", error);
		try {
			transcript = await createSimpleTranscript(channel, `entretien-${member.user.username}-${channel.id}.html`);
			embed.addFields({
				name: 'Transcript',
				value: "Transcript simple genere car le rendu avance a echoue.",
				inline: false
			});
		} catch (fallbackError) {
			transcriptFailed = true;
			console.error("Erreur lors de la creation du transcript simple entretien:", fallbackError);
			embed.addFields({
				name: 'Transcript',
				value: "Impossible de generer le transcript, fermeture continue.",
				inline: false
			});
		}
	}

	try {
		if (transcript) {
			await logChannel.send({ embeds: [embed], files: [transcript] });
		} else {
			await logChannel.send({ embeds: [embed] });
		}
	} catch (error) {
		console.error("Erreur lors de l'envoi du log entretien:", error);
		transcriptFailed = true;
	}

	if (accepted) {
		await sendDm(member.user, `Ton entretien sur l'Utopie a été accepté par ${interaction.user.tag}!`);
	} else {
		await sendDm(member.user, `Ton entretien sur l'Utopie a été refusé par ${interaction.user.tag}!`);
	}

	await dbRun('UPDATE entretien_tickets SET status = ? WHERE channelId = ?', [accepted ? 'accepted' : 'denied', channel.id]);
	const transcriptStatus = transcriptFailed ? 'Transcript/log indisponible, ' : 'Transcript envoye, ';
	await interaction.editReply(`Entretien ${resultText}. ${transcriptStatus}role ajoute, fermeture du salon...`);
	await channel.send(`Entretien ${resultText} par ${interaction.user}. Fermeture du salon...`).catch(() => { });

	setTimeout(() => {
		channel.delete().catch(console.error);
	}, 3000);
};

const handleEntretienConfig = async interaction => {
	const current = await dbGet('SELECT * FROM entretien WHERE guild = ?', [interaction.guild.id]).catch(() => null);

	const embed = new EmbedBuilder()
		.setTitle('Configuration entretien')
		.setDescription([
			'Selectionne le parametre a modifier dans le menu.',
			'Le bot ouvrira ensuite un questionnaire prive pour entrer la nouvelle valeur.',
			'Tu peux utiliser une mention ou un ID.'
		].join('\n'))
		.addFields(
			{ name: 'Actuel staff', value: current?.staffRole ? `<@&${current.staffRole}>` : '`Non configure`', inline: true },
			{ name: 'Actuel accepte', value: current?.acceptRole ? `<@&${current.acceptRole}>` : '`Non configure`', inline: true },
			{ name: 'Actuel refuse', value: current?.denyRole ? `<@&${current.denyRole}>` : '`Non configure`', inline: true },
			{ name: 'Actuel logs', value: current?.logChannel ? `<#${current.logChannel}>` : '`Non configure`', inline: true },
			{ name: 'Actuelle categorie', value: current?.category ? `<#${current.category}>` : '`Aucune`', inline: true }
		)
		.setColor(0x5865F2);

	const menu = new StringSelectMenuBuilder()
		.setCustomId('entretien_config_select')
		.setPlaceholder('Parametre a modifier')
		.addOptions(
			{ label: 'Role staff entretien', value: 'staffRole', description: 'Role autorise a gerer les entretiens', emoji: '🛡️' },
			{ label: 'Role entretien accepte', value: 'acceptRole', description: 'Role donne quand le membre est accepte', emoji: '✅' },
			{ label: 'Role entretien refuse', value: 'denyRole', description: 'Role donne quand le membre est refuse', emoji: '❌' },
			{ label: 'Salon de logs', value: 'logChannel', description: 'Salon ou envoyer transcripts et decisions', emoji: '📄' },
			{ label: 'Categorie tickets', value: 'category', description: 'Categorie ou creer les salons, ou off', emoji: '📁' }
		);

	return interaction.reply({
		embeds: [embed],
		components: [new ActionRowBuilder().addComponents(menu)],
		flags: Discord.MessageFlags.Ephemeral
	});
};

const openEntretienConfigModal = async interaction => {
	const field = interaction.values[0];
	const labels = {
		staffRole: 'Role staff entretien',
		acceptRole: 'Role entretien accepte',
		denyRole: 'Role entretien refuse',
		logChannel: 'Salon de logs',
		category: 'Categorie tickets'
	};
	const placeholders = {
		staffRole: '@Staff ou ID du role',
		acceptRole: '@Verifie ou ID du role',
		denyRole: '@Entretien refuse ou ID du role',
		logChannel: '#logs ou ID du salon',
		category: '#categorie, ID de categorie, off ou skip'
	};

	if (!labels[field]) {
		return interaction.reply({
			content: "Parametre inconnu.",
			flags: Discord.MessageFlags.Ephemeral
		});
	}

	const modal = new ModalBuilder()
		.setCustomId(`entretien_config_modal_${field}`)
		.setTitle(labels[field]);

	const input = new TextInputBuilder()
		.setCustomId('value')
		.setLabel('Nouvelle valeur')
		.setPlaceholder(placeholders[field])
		.setStyle(TextInputStyle.Short)
		.setRequired(true)
		.setMaxLength(100);

	modal.addComponents(new ActionRowBuilder().addComponents(input));
	return interaction.showModal(modal);
};

const saveEntretienConfigModal = async interaction => {
	const field = interaction.customId.replace('entretien_config_modal_', '');
	const allowedFields = ['staffRole', 'acceptRole', 'denyRole', 'logChannel', 'category'];

	if (!allowedFields.includes(field)) {
		return interaction.reply({
			content: "Parametre inconnu.",
			flags: Discord.MessageFlags.Ephemeral
		});
	}

	const rawValue = interaction.fields.getTextInputValue('value').trim();
	const cleanId = rawValue.replace(/[<@#&>]/g, '');
	let savedValue = cleanId;
	let displayValue = rawValue;

	if (['staffRole', 'acceptRole', 'denyRole'].includes(field)) {
		const role = interaction.guild.roles.cache.get(cleanId);
		if (!role) {
			return interaction.reply({
				content: "Role introuvable. Envoie une mention de role ou un ID valide.",
				flags: Discord.MessageFlags.Ephemeral
			});
		}
		savedValue = role.id;
		displayValue = `${role}`;
	}

	if (field === 'logChannel') {
		const channel = interaction.guild.channels.cache.get(cleanId);
		if (!channel || !channel.isTextBased()) {
			return interaction.reply({
				content: "Salon de logs introuvable. Envoie une mention de salon texte ou un ID valide.",
				flags: Discord.MessageFlags.Ephemeral
			});
		}
		savedValue = channel.id;
		displayValue = `${channel}`;
	}

	if (field === 'category') {
		if (['off', 'skip', 'none', 'aucune'].includes(rawValue.toLowerCase())) {
			savedValue = null;
			displayValue = '`Aucune categorie`';
		} else {
			const category = interaction.guild.channels.cache.get(cleanId);
			if (!category || category.type !== Discord.ChannelType.GuildCategory) {
				return interaction.reply({
					content: "Categorie introuvable. Envoie une categorie valide, son ID, ou `off`.",
					flags: Discord.MessageFlags.Ephemeral
				});
			}
			savedValue = category.id;
			displayValue = `${category}`;
		}
	}

	await dbRun('INSERT OR IGNORE INTO entretien (guild) VALUES (?)', [interaction.guild.id]);
	await dbRun(`UPDATE entretien SET ${field} = ? WHERE guild = ?`, [savedValue, interaction.guild.id]);

	return interaction.reply({
		content: `Configuration mise a jour: ${displayValue}`,
		flags: Discord.MessageFlags.Ephemeral
	});
};

const handleEntretienDecision = async (interaction, accepted) => {
	const settings = await dbGet('SELECT * FROM entretien WHERE guild = ?', [interaction.guild.id]);

	if (!isEntretienStaff(interaction.member, settings)) {
		return interaction.reply({
			content: "Tu n'as pas acces a ce panel.",
			flags: Discord.MessageFlags.Ephemeral
		});
	}

	const ticket = await getOpenEntretienTicket(interaction.guild.id, interaction.channel.id);
	if (!ticket) {
		return interaction.reply({
			content: "Cette action doit etre utilisee dans un salon d'entretien ouvert.",
			flags: Discord.MessageFlags.Ephemeral
		});
	}

	return closeEntretien(interaction, ticket, settings, accepted).catch(async error => {
		console.error(error);
		const content = "Erreur pendant la fermeture de l'entretien.";
		if (interaction.deferred || interaction.replied) {
			return interaction.editReply(content).catch(() => { });
		}
		return interaction.reply({ content, flags: Discord.MessageFlags.Ephemeral }).catch(() => { });
	});
};

export default {
	name: 'interactionCreate',
	async execute(interaction, bot, config) {
		if (interaction.isCommand()) {
			const cmd = bot.slashCommands.get(interaction.commandName);
			if (!cmd) return;

			const args = [];
			for (const option of interaction.options.data) {
				if (option.type === 1) {
					if (option.name) args.push(option.name);
					option.options?.forEach(x => {
						if (x.value) args.push(x.value);
					});
				} else if (option.value) {
					args.push(option.value);
				}
			}
			cmd.run(bot, interaction, args, config);
			return;
		}

		if (interaction.isButton() && interaction.customId === 'confess_open') {
			const modal = new ModalBuilder()
				.setCustomId('confess_modal')
				.setTitle('Faire une confession');

			const input = new TextInputBuilder()
				.setCustomId('confess_text')
				.setLabel('Ta confession')
				.setStyle(TextInputStyle.Paragraph)
				.setRequired(true)
				.setMaxLength(2000);

			modal.addComponents(new ActionRowBuilder().addComponents(input));
			return interaction.showModal(modal);
		}

		if (interaction.isModalSubmit() && interaction.customId === 'confess_modal') {
			const confession = interaction.fields.getTextInputValue('confess_text');
			db.get('SELECT channel FROM Confess WHERE guildId = ?', [interaction.guild.id], async (err, row) => {
				if (err || !row || row.channel === 'off') {
					return interaction.reply({ content: "Le salon de confession n'est pas configure.", flags: Discord.MessageFlags.Ephemeral });
				}

				const confessChannel = interaction.guild.channels.cache.get(row.channel);
				if (!confessChannel) {
					return interaction.reply({ content: "Le salon de confession est introuvable.", flags: Discord.MessageFlags.Ephemeral });
				}

				const confessionNumber = await new Promise(resolve => {
					db.get('SELECT COUNT(*) as count FROM confesslogs WHERE guildId = ?', [interaction.guild.id], (err2, row2) => {
						if (!err2 && row2) return resolve(row2.count + 1);
						resolve(1);
					});
				});

				db.run('INSERT INTO confesslogs (guildId, userId, message) VALUES (?, ?, ?)', [interaction.guild.id, interaction.user.id, confession]);

				const embed = new EmbedBuilder()
					.setTitle(`Confession #${confessionNumber}`)
					.setDescription(confession)
					.setColor(config.color);

				const messages = await confessChannel.messages.fetch({ limit: 10 });
				const lastBotMsg = messages.find(message => message.author.id === interaction.client.user.id && message.components.length > 0);
				if (lastBotMsg) await lastBotMsg.edit({ components: [] }).catch(() => { });

				const rowBtn = new ActionRowBuilder().addComponents(
					new ButtonBuilder()
						.setCustomId('confess_open')
						.setLabel('Se confesser')
						.setStyle(ButtonStyle.Primary)
				);

				return confessChannel.send({ embeds: [embed], components: [rowBtn] });
			});
		}

		if (interaction.isButton() && interaction.customId.startsWith('giveaway_')) {
			const [, action, messageId] = interaction.customId.split('_');
			if (action === 'reroll') {
				return bot.giveawaysManager.reroll(messageId)
					.then(() => interaction.reply({ content: "Reroll", flags: Discord.MessageFlags.Ephemeral }))
					.catch(() => interaction.reply({ content: "Erreur lors du reroll.", flags: Discord.MessageFlags.Ephemeral }));
			}
			if (action === 'end') {
				return bot.giveawaysManager.end(messageId)
					.then(() => interaction.reply({ content: "Giveaway termine !", flags: Discord.MessageFlags.Ephemeral }))
					.catch(() => interaction.reply({ content: "Erreur lors de la fin du giveaway.", flags: Discord.MessageFlags.Ephemeral }));
			}
		}

		if (interaction.isButton() && interaction.customId === 'cbutton') {
			try {
				const guild = interaction.guild;
				const member = interaction.member;
				const settings = await dbGet('SELECT * FROM entretien WHERE guild = ?', [guild.id]);

				if (!settings?.staffRole || !settings?.acceptRole || !settings?.denyRole || !settings?.logChannel) {
					return interaction.reply({
						content: "Le systeme entretien n'est pas encore configure.",
						flags: Discord.MessageFlags.Ephemeral
					});
				}

				const staffRole = guild.roles.cache.get(settings.staffRole);
				if (!staffRole) {
					return interaction.reply({
						content: "Le role staff entretien est introuvable.",
						flags: Discord.MessageFlags.Ephemeral
					});
				}

				const existingTicket = await dbGet(
					"SELECT channelId FROM entretien_tickets WHERE guild = ? AND userId = ? AND status = 'open'",
					[guild.id, member.id]
				);
				const existingChannel = existingTicket ? guild.channels.cache.get(existingTicket.channelId) : null;

				if (existingChannel) {
					return interaction.reply({
						content: `Tu as deja une demande de verification ouverte: ${existingChannel}`,
						flags: Discord.MessageFlags.Ephemeral
					});
				}

				if (existingTicket && !existingChannel) {
					await dbRun('UPDATE entretien_tickets SET status = ? WHERE channelId = ?', ['closed', existingTicket.channelId]);
				}

				const baseName = member.user.username.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || member.id;
				const channelName = `entretien-${baseName}`.slice(0, 90);
				const parent = settings.category && guild.channels.cache.has(settings.category) ? settings.category : null;

				const channel = await guild.channels.create({
					name: channelName,
					type: Discord.ChannelType.GuildText,
					parent,
					topic: `Entretien de verification - ${member.user.tag} (${member.id})`,
					permissionOverwrites: [
						{
							id: guild.id,
							deny: [Discord.PermissionFlagsBits.ViewChannel]
						},
						{
							id: member.id,
							allow: [
								Discord.PermissionFlagsBits.ViewChannel,
								Discord.PermissionFlagsBits.SendMessages,
								Discord.PermissionFlagsBits.ReadMessageHistory
							]
						},
						{
							id: staffRole.id,
							allow: [
								Discord.PermissionFlagsBits.ViewChannel,
								Discord.PermissionFlagsBits.SendMessages,
								Discord.PermissionFlagsBits.ReadMessageHistory,
								Discord.PermissionFlagsBits.ManageMessages
							]
						},
						{
							id: bot.user.id,
							allow: [
								Discord.PermissionFlagsBits.ViewChannel,
								Discord.PermissionFlagsBits.SendMessages,
								Discord.PermissionFlagsBits.ReadMessageHistory,
								Discord.PermissionFlagsBits.ManageChannels,
								Discord.PermissionFlagsBits.AttachFiles
							]
						}
					]
				});

				await dbRun(
					'INSERT OR REPLACE INTO entretien_tickets (channelId, guild, userId, status, createdAt) VALUES (?, ?, ?, ?, ?)',
					[channel.id, guild.id, member.id, 'open', Date.now()]
				);

				const panel = new ActionRowBuilder().addComponents(
					new ButtonBuilder()
						.setCustomId('entretien_accept')
						.setLabel('Accepter')
						.setStyle(ButtonStyle.Success),
					new ButtonBuilder()
						.setCustomId('entretien_deny')
						.setLabel('Refuser')
						.setStyle(ButtonStyle.Danger)
				);

				const embed = new EmbedBuilder()
					.setTitle('Entretien de verification')
					.setDescription([
						`${member}, merci de patienter ici.`,
						`Un membre du staff va te poser quelques questions.`,
						`Le staff peut accepter ou refuser cet entretien avec les boutons ci-dessous ou avec le panel +entretien.`
					].join('\n'))
					.setColor(config.color)
					.setTimestamp();

				await channel.send({
					content: `${member} <@&${staffRole.id}>`,
					embeds: [embed],
					components: [panel]
				});

				return interaction.reply({
					content: `Ta demande d'entretien a ete creee: ${channel}`,
					flags: Discord.MessageFlags.Ephemeral
				});
			} catch (e) {
				console.error(e);
				return interaction.reply({
					content: "Impossible de creer le salon d'entretien.",
					flags: Discord.MessageFlags.Ephemeral
				});
			}
		}

		if (interaction.isButton() && interaction.customId === 'suggest_open') {
			const modal = new ModalBuilder()
				.setCustomId('suggest_modal')
				.setTitle('Faire une suggestion');

			const input = new TextInputBuilder()
				.setCustomId('suggest_text')
				.setLabel('Ta suggestion')
				.setStyle(TextInputStyle.Paragraph)
				.setRequired(true)
				.setMaxLength(2000);

			modal.addComponents(new ActionRowBuilder().addComponents(input));
			return interaction.showModal(modal);
		}

		if (interaction.isStringSelectMenu() && interaction.customId === 'entretien_menu') {
			const choice = interaction.values[0];

			if (choice === 'config') {
				if (!(await canEditEntretienConfig(interaction, config))) {
					return interaction.reply({
						content: "Tu n'as pas acces a la configuration entretien.",
						flags: Discord.MessageFlags.Ephemeral
					});
				}

				return handleEntretienConfig(interaction);
			}

			if (choice === 'approve') return handleEntretienDecision(interaction, true);
			if (choice === 'deny') return handleEntretienDecision(interaction, false);
		}

		if (interaction.isStringSelectMenu() && interaction.customId === 'entretien_config_select') {
			if (!(await canEditEntretienConfig(interaction, config))) {
				return interaction.reply({
					content: "Tu n'as pas acces a la configuration entretien.",
					flags: Discord.MessageFlags.Ephemeral
				});
			}

			return openEntretienConfigModal(interaction);
		}

		if (interaction.isButton() && interaction.customId === 'entretien_accept') {
			return handleEntretienDecision(interaction, true);
		}

		if (interaction.isButton() && interaction.customId === 'entretien_deny') {
			return handleEntretienDecision(interaction, false);
		}

		if (interaction.isModalSubmit() && interaction.customId.startsWith('entretien_config_modal_')) {
			if (!(await canEditEntretienConfig(interaction, config))) {
				return interaction.reply({
					content: "Tu n'as pas acces a la configuration entretien.",
					flags: Discord.MessageFlags.Ephemeral
				});
			}

			return saveEntretienConfigModal(interaction);
		}

		if (interaction.isModalSubmit() && interaction.customId === 'suggest_modal') {
			const suggestion = interaction.fields.getTextInputValue('suggest_text');
			db.get('SELECT channel FROM Suggest WHERE guildId = ?', [interaction.guild.id], async (err, row) => {
				if (err || !row || row.channel === 'off') {
					return interaction.reply({ content: "Le salon de suggestion n'est pas configure.", flags: Discord.MessageFlags.Ephemeral });
				}

				const suggestChannel = interaction.guild.channels.cache.get(row.channel);
				if (!suggestChannel) {
					return interaction.reply({ content: "Le salon de suggestion est introuvable.", flags: Discord.MessageFlags.Ephemeral });
				}

				const messages = await suggestChannel.messages.fetch({ limit: 10 });
				const lastBotMsg = messages.find(message => message.author.id === interaction.client.user.id && message.components.length > 0);
				if (lastBotMsg) await lastBotMsg.edit({ components: [] }).catch(() => { });

				const embed = new EmbedBuilder()
					.setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() })
					.setTitle('Suggestion')
					.setDescription(suggestion)
					.setColor(config.color);

				const rowBtn = new ActionRowBuilder().addComponents(
					new ButtonBuilder()
						.setCustomId('suggest_open')
						.setLabel('Faire une suggestion')
						.setStyle(ButtonStyle.Primary)
				);

				const sentMsg = await suggestChannel.send({ embeds: [embed], components: [rowBtn] });
				await sentMsg.react('✅');
				return sentMsg.react('❌');
			});
		}

		if (interaction.isButton() && interaction.customId === 'ticket_close') {
			db.run('DELETE FROM ticketchannel WHERE channelId = ?', [interaction.channel.id], err => {
				if (err) console.error(err);
			});
			return interaction.channel.delete().catch(() => { });
		}

		if (interaction.isStringSelectMenu() && interaction.customId === 'ticket_select') {
			const optiontxt = config[interaction.values[0]] || 'Ticket';
			const existing = interaction.guild.channels.cache.find(channel =>
				channel.topic === `${optiontxt} - ${interaction.user.username}`
			);

			if (existing) {
				return interaction.reply({ content: 'Vous avez deja un ticket ouvert.', flags: Discord.MessageFlags.Ephemeral });
			}

			db.get('SELECT category FROM ticket WHERE guild = ?', [interaction.guild.id], async (err, row) => {
				if (err) return console.error(err);

				let parent = row?.category || null;
				if (parent && typeof parent !== 'string') parent = String(parent);

				const category = interaction.guild.channels.cache.get(parent);
				if (!category) {
					return interaction.reply({ content: 'Categorie invalide.', flags: Discord.MessageFlags.Ephemeral });
				}

				const permissionOverwrites = category.permissionOverwrites.cache.size > 0
					? category.permissionOverwrites.cache.map(permission => ({
						id: permission.id,
						allow: permission.allow.toArray(),
						deny: permission.deny.toArray(),
					}))
					: [];

				permissionOverwrites.push({
					id: interaction.user.id,
					allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"],
				});

				const ticketChannel = await interaction.guild.channels.create({
					name: `ticket-${interaction.user.username}`,
					type: Discord.ChannelType.GuildText,
					topic: `${optiontxt} - ${interaction.user.username}`,
					parent: category,
					permissionOverwrites: permissionOverwrites.length > 0 ? permissionOverwrites : undefined,
				});

				db.run(
					'INSERT INTO ticketchannel (channelId) VALUES (?)',
					[ticketChannel.id],
					error => { if (error) console.error(error); }
				);

				const close = new ActionRowBuilder().addComponents(
					new ButtonBuilder()
						.setCustomId('ticket_close')
						.setLabel('Fermer le ticket')
						.setStyle(ButtonStyle.Danger)
				);

				await ticketChannel.send({
					content: `<@${interaction.user.id}>`,
					embeds: [
						new EmbedBuilder()
							.setTitle('Ticket - ' + optiontxt)
							.setDescription('Expliquez votre probleme, un membre du staff va vous repondre.\n\nPour fermer le ticket, cliquez sur le bouton fermer le ticket')
							.setColor(config.color)
							.setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() })
							.setThumbnail(interaction.user.displayAvatarURL())
							.setFooter({ text: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() })
							.setTimestamp()
					],
					components: [close]
				});

				return interaction.reply({ content: `Ticket cree: ${ticketChannel}`, flags: Discord.MessageFlags.Ephemeral });
			});
		}
	}
};
