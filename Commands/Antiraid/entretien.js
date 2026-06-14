import { ActionRowBuilder, EmbedBuilder, StringSelectMenuBuilder } from 'discord.js';
import db from '../../Events/loadDatabase.js';

const getEntretienConfig = guildId => new Promise((resolve, reject) => {
	db.get('SELECT * FROM entretien WHERE guild = ?', [guildId], (err, row) => {
		if (err) return reject(err);
		resolve(row || {});
	});
});

const checkPerm = async (message, commandName, config) => {
	if (config.owners.includes(message.author.id)) return true;

	const publicStatut = await new Promise((resolve, reject) => {
		db.get('SELECT statut FROM public WHERE guild = ? AND statut = ?', [message.guild.id, 'on'], (err, row) => {
			if (err) return reject(err);
			resolve(!!row);
		});
	});

	if (publicStatut) {
		const checkPublicCmd = await new Promise((resolve, reject) => {
			db.get(
				'SELECT command FROM cmdperm WHERE perm = ? AND command = ? AND guild = ?',
				['public', commandName, message.guild.id],
				(err, row) => {
					if (err) return reject(err);
					resolve(!!row);
				}
			);
		});

		if (checkPublicCmd) return true;
	}

	try {
		const checkUserWl = await new Promise((resolve, reject) => {
			db.get('SELECT id FROM whitelist WHERE id = ?', [message.author.id], (err, row) => {
				if (err) return reject(err);
				resolve(!!row);
			});
		});

		if (checkUserWl) return true;

		const checkDbOwner = await new Promise((resolve, reject) => {
			db.get('SELECT id FROM owner WHERE id = ?', [message.author.id], (err, row) => {
				if (err) return reject(err);
				resolve(!!row);
			});
		});

		if (checkDbOwner) return true;

		const roles = message.member.roles.cache.map(role => role.id);
		if (roles.length === 0) return false;

		const permissions = await new Promise((resolve, reject) => {
			db.all('SELECT perm FROM permissions WHERE id IN (' + roles.map(() => '?').join(',') + ') AND guild = ?', [...roles, message.guild.id], (err, rows) => {
				if (err) return reject(err);
				resolve(rows.map(row => row.perm));
			});
		});

		if (permissions.length === 0) return false;

		const checkCmdPermLevel = await new Promise((resolve, reject) => {
			db.all('SELECT command FROM cmdperm WHERE perm IN (' + permissions.map(() => '?').join(',') + ') AND guild = ?', [...permissions, message.guild.id], (err, rows) => {
				if (err) return reject(err);
				resolve(rows.map(row => row.command));
			});
		});

		return checkCmdPermLevel.includes(commandName);
	} catch (error) {
		console.error('Erreur lors de la verification des permissions:', error);
		return false;
	}
};

export const command = {
	name: 'entretien',
	helpname: 'entretien',
	description: 'Panel entretien staff',
	help: 'entretien',

	run: async (bot, message, args, config) => {
		if (!(await checkPerm(message, command.name, config))) {
			const noacces = new EmbedBuilder()
				.setDescription("Vous n'avez pas la permission d'utiliser cette commande")
				.setColor(config.color);
			return message.reply({ embeds: [noacces], allowedMentions: { repliedUser: true } }).then(m => setTimeout(() => m.delete().catch(() => { }), 2000));
		}

		const settings = await getEntretienConfig(message.guild.id).catch(err => {
			console.error(err);
			return {};
		});

		const embed = new EmbedBuilder()
			.setTitle('Panel Entretien')
			.setDescription([
				'Utilisez ce panel dans un salon entretien pour accepter ou refuser le membre.',
				'La configuration permet de definir les roles, le salon de logs et la categorie des tickets.'
			].join('\n'))
			.addFields(
				{ name: 'Role staff', value: settings.staffRole ? `<@&${settings.staffRole}>` : '`Non configure`', inline: true },
				{ name: 'Role accepte', value: settings.acceptRole ? `<@&${settings.acceptRole}>` : '`Non configure`', inline: true },
				{ name: 'Role refuse', value: settings.denyRole ? `<@&${settings.denyRole}>` : '`Non configure`', inline: true },
				{ name: 'Salon logs', value: settings.logChannel ? `<#${settings.logChannel}>` : '`Non configure`', inline: true },
				{ name: 'Categorie tickets', value: settings.category ? `<#${settings.category}>` : '`Aucune`', inline: true }
			)
			.setColor(config.color);

		const menu = new StringSelectMenuBuilder()
			.setCustomId('entretien_menu')
			.setPlaceholder('Choisir une action')
			.addOptions(
				{
					label: 'Accepter cet entretien',
					value: 'approve',
					emoji: '✅'
				},
				{
					label: 'Refuser cet entretien',
					value: 'deny',
					emoji: '❌'
				},
				{
					label: 'Configuration',
					value: 'config',
					emoji: '⚙️'
				}
			);

		const row = new ActionRowBuilder().addComponents(menu);

		return message.channel.send({
			embeds: [embed],
			components: [row]
		});
	}
};
