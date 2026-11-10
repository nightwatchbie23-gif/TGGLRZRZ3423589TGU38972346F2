'use strict';

const { ChannelType, MessageFlags, SlashCommandBuilder } = require('discord.js');
const { PlayerService, CHANNEL_NAME } = require('../services/players');
const { error, success } = require('../utils/format');

// /players create | refresh | clean  (admins only)

const DATA = new SlashCommandBuilder()
    .setName('players')
    .setDescription('Player card board (logs-subs channel)')
    .addSubcommand((sc) => sc.setName('create').setDescription(`Create the #${CHANNEL_NAME} board and render every player card`))
    .addSubcommand((sc) => sc.setName('refresh').setDescription('Re-render all player cards right now'))
    .addSubcommand((sc) => sc.setName('clean').setDescription('Archive old logs to a DM file, wipe the board and the login events'));

module.exports = {
    data: DATA,
    async execute(interaction, ctx) {
        if (!ctx.players) {
            return interaction.reply({ embeds: [error('Unavailable', 'Player board service is not running (missing Discord guild?).')], flags: MessageFlags.Ephemeral });
        }
        switch (interaction.options.getSubcommand()) {
            case 'create': return subCreate(interaction, ctx);
            case 'refresh': return subRefresh(interaction, ctx);
            case 'clean': return subClean(interaction, ctx);
            default:
                return interaction.reply({ embeds: [error('Unknown subcommand', 'See /players create.')], flags: MessageFlags.Ephemeral });
        }
    }
};

async function subCreate(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
        const { channel, created } = await ctx.players.ensureChannel(interaction.guild);
        const result = await ctx.players.renderAllCards(ctx);
        await ctx.db.audit('players_board_created', {
            actor: interaction.user.id,
            target: channel.id,
            details: { created }
        });
        const description = created
            ? `Created locked channel <#${channel.id}> (hidden from @everyone \u2014 admins only).`
            : `Reused existing <#${channel.id}>.`;
        return interaction.editReply({
            embeds: [result.ok
                ? success('Player Board Ready', [
                    description,
                    `${result.updated} card(s) rendered \u2014 each card auto-refreshes when that player logs in with the client.`,
                    'New players get a card automatically on first login.',
                    'Cards re-render daily; `/players refresh` forces it now.'
                ].join('\n'))
                : error('Board Created, Rendering Failed', `${description}\n${result.reason}`)]
        });
    } catch (error_) {
        return interaction.editReply({ embeds: [error('Setup Failed', error_.message)] });
    }
}

async function subRefresh(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await ctx.players.renderAllCards(ctx);
    return interaction.editReply({
        embeds: [result.ok
            ? success('Board Refreshed', [
                `\u{1F504} ${result.updated} card(s) re-rendered.`,
                `${result.players} player card(s) currently on the board.`,
                'This also runs automatically every day.'
            ].join('\n'))
            : error('Refresh Failed', result.reason)]
    });
}

async function subClean(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await ctx.players.cleanBoard(ctx);
    try {
        await interaction.user.send({
            content: `\u{1F4E6} Player logs archive (before cleaning) \u2014 ${result.events} login event(s) snapshot included.`,
            files: [{ attachment: result.file.attachment, name: result.file.name }]
        });
    } catch {
        return interaction.editReply({
            embeds: [error('Clean Done, DM Failed', `Board wiped (${result.deletedCards} card message(s), ${result.purgedEvents} login events purged), but your DMs are closed so the archive file was NOT delivered.`)]
        });
    }
    try {
        await ctx.db.audit('players_logs_archived', { actor: interaction.user.id, details: { events: result.events } });
    } catch { /* best effort */ }
    return interaction.editReply({
        embeds: [success('Logs Archived & Board Cleaned', [
            `\u{1F5D1}\uFE0F Board wiped: ${result.deletedCards} old card message(s) deleted.`,
            `\u{1F5BE} ${result.events} login event(s) archived; ${result.purgedEvents} purged from storage.`,
            '\u{1F4E5} The archive JSON was sent to your DMs.',
            'New cards appear automatically as players log in again.'
        ].join('\n'))]
    });
}
