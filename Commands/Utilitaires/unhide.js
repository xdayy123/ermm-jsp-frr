import * as Discord from "discord.js";
import db from "../../Events/loadDatabase.js";
import { EmbedBuilder } from "discord.js";
import sendLog from "../../Events/sendlog.js";

export const command = {
	name: 'unhide',
	helpname: 'unhide [salon]',
	description: 'Permet de rendre un salon visible pour tout le monde.',
	help: 'unhide [salon]',
	run: async (bot, message, args, config) => {
		const checkPerm = async (message, commandName) => {
			if (config.owners.includes(message.author.id)) {
				return true;
			}

			const publicStatut = await new Promise((resolve, reject) => {
				db.get('SELECT statut FROM public WHERE guild = ? AND statut = ?', [message.guild.id, 'on'], (err, row) => {
					if (err) reject(err);
					resolve(!!row);
				});
			});

			if (publicStatut) {
				const checkPublicCmd = await new Promise((resolve, reject) => {
					db.get(
						'SELECT command FROM cmdperm WHERE perm = ? AND command = ? AND guild = ?',
						['public', commandName, message.guild.id],
						(err, row) => {
							if (err) reject(err);
							resolve(!!row);
						}
					);
				});

				if (checkPublicCmd) {
					return true;
				}
			}

			try {
				const checkUserWl = await new Promise((resolve, reject) => {
					db.get('SELECT id FROM whitelist WHERE id = ?', [message.author.id], (err, row) => {
						if (err) reject(err);
						resolve(!!row);
					});
				});

				if (checkUserWl) {
					return true;
				}

				const checkDbOwner = await new Promise((resolve, reject) => {
					db.get('SELECT id FROM owner WHERE id = ?', [message.author.id], (err, row) => {
						if (err) reject(err);
						resolve(!!row);
					});
				});

				if (checkDbOwner) {
					return true;
				}

				const roles = message.member.roles.cache.map(role => role.id);

				const permissions = await new Promise((resolve, reject) => {
					db.all('SELECT perm FROM permissions WHERE id IN (' + roles.map(() => '?').join(',') + ') AND guild = ?', [...roles, message.guild.id], (err, rows) => {
						if (err) reject(err);
						resolve(rows.map(row => row.perm));
					});
				});

				if (permissions.length === 0) {
					return false;
				}

				const checkCmdPermLevel = await new Promise((resolve, reject) => {
					db.all('SELECT command FROM cmdperm WHERE perm IN (' + permissions.map(() => '?').join(',') + ') AND guild = ?', [...permissions, message.guild.id], (err, rows) => {
						if (err) reject(err);
						resolve(rows.map(row => row.command));
					});
				});

				return checkCmdPermLevel.includes(commandName);
			} catch (error) {
				console.error('Erreur lors de la verification des permissions:', error);
				return false;
			}
		};

		if (!(await checkPerm(message, command.name))) {
			const noacces = new EmbedBuilder()
				.setDescription("Vous n'avez pas la permission d'utiliser cette commande")
				.setColor(config.color);
			return message.reply({ embeds: [noacces], allowedMentions: { repliedUser: true } }).then(m => setTimeout(() => m.delete().catch(() => { }), 2000));
		}

		const channelId = args[0]?.replace(/[<#>]/g, '');
		const channel = message.mentions.channels.first() || message.guild.channels.cache.get(channelId) || message.channel;

		if (!channel?.permissionOverwrites) {
			return message.reply("Salon invalide.").then(m => setTimeout(() => m.delete().catch(() => { }), 3000));
		}

		try {
			await channel.permissionOverwrites.edit(message.guild.roles.everyone, {
				[Discord.PermissionFlagsBits.ViewChannel]: null,
			});

			const infoMessage = await message.channel.send(`<#${channel.id}> est de nouveau visible pour tout le monde.`);
			const embed = new Discord.EmbedBuilder()
				.setColor(config.color)
				.setDescription(`<@${message.author.id}> a unhide <#${channel.id}>`)
				.setTimestamp();

			sendLog(message.guild, embed, 'modlog');
			setTimeout(() => {
				infoMessage.delete().catch(() => { });
			}, 3000);

			await message.delete().catch(() => { });
		} catch (err) {
			console.error('Erreur lors du unhide du salon:', err);
			return message.reply("Impossible de rendre ce salon visible. Verifie mes permissions.").then(m => setTimeout(() => m.delete().catch(() => { }), 3000));
		}
	},
};
