import { ActivityType } from "discord.js";

export default {
	name: 'clientReady',
	async execute(bot) {
		await bot.application.commands.set(bot.arrayOfSlashCommands);

		bot.user.setPresence({
			activities: [{ name: "Le Lancement de l'Utopie 👑", type: ActivityType.Playing, url: 'https://twitch.tv/discord' }], status: 'dnd'
		});
	}
};
