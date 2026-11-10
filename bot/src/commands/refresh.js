'use strict';

const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const { COLORS, base, error, info } = require('../utils/format');

// /refresh logs \u2014 convenience alias: archives player + login logs to a DM
// file, wipes the player board, and purges login events (fresh start).
// Requires the player board service (/players create first if not done).

const DATA = new SlashCommandBuilder()
    .setName('refresh')
    .setDescription('Maintenance tasks')
    .addSubcommand((sc) => sc
        .setName('logs')
        .setDescription('Send old player/login logs to your DMs as a file, then clean the board'));

module.exports = {
    data: DATA,
    async execute(interaction, ctx) {
        switch (interaction.options.getSubcommand()) {
            case 'logs': {
                if (!ctx.players) {
                    return interaction.reply({ embeds: [error('Unavailable', 'Run /players create first \u2014 the player board service is not active.')], flags: MessageFlags.Ephemeral });
                }
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const result = await ctx.players.cleanBoard(ctx);
                try {
                    await interaction.user.send({
                        content: `\u{1F4E6} Player logs archive (before cleaning) \u2014 ${result.events} login event(s) snapshot included.`,
                        files: [{ attachment: result.file.attachment, name: result.file.name }]
                    });
                } catch {
                    return interaction.editReply({
                        embeds: [error('DM Failed', `Board cleaned (${result.deletedCards} card(s), ${result.purgedEvents} purged events), but your DMs are closed \u2014 the archive file was NOT delivered.`)]
                    });
                }
                try { await ctx.db.audit('player_logs_archived', { actor: interaction.user.id, details: { events: result.events, via: 'refresh' } }); } catch { /* best effort */ }
                const note = base('Board Refreshed', COLORS.primary);
                note.description = [
                    `\u{1F5D1}\uFE0F Cleaned: ${result.deletedCards} card message(s), ${result.purgedEvents} login event(s) purged.`,
                    `\u{1F4E5} Old logs (${result.events} events) sent to your DMs.`,
                    'Cards rebuild automatically as players log in again.'
                ].join('\n');
                return interaction.editReply({ embeds: [note] });
            }
            default:
                return interaction.reply({ embeds: [info('Unknown subcommand', 'Use `/refresh logs`.')], flags: MessageFlags.Ephemeral });
        }
    }
};
