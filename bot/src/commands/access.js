'use strict';

const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const { addAllowedUser, isAdmin, removeAllowedUser } = require('../utils/guards');
const { COLORS, error, success, info } = require('../utils/format');

// Manage who may use the bot. Admins come from ADMIN_USER_IDS (env); granted
// users are stored in Supabase bot_settings and can use normal commands
// (license, hwid, login, server) but not admin-only ones.

const DATA = new SlashCommandBuilder()
    .setName('access')
    .setDescription('Manage who can use the bot')
    .addSubcommand((sc) => sc
        .setName('add')
        .setDescription('Grant a user access to the bot')
        .addUserOption((opt) => opt
            .setName('user')
            .setDescription('User to grant access')
            .setRequired(true)))
    .addSubcommand((sc) => sc
        .setName('remove')
        .setDescription("Revoke a user's access")
        .addUserOption((opt) => opt
            .setName('user')
            .setDescription('User whose access is revoked')
            .setRequired(true)))
    .addSubcommand((sc) => sc
        .setName('list')
        .setDescription('Show everyone who can use the bot'));

module.exports = {
    data: DATA,
    async execute(interaction, ctx) {
        if (!isAdmin(ctx.config, interaction.user.id)) {
            return interaction.reply({ embeds: [error('Not Authorized', 'Only administrators can manage access.')], flags: MessageFlags.Ephemeral });
        }
        switch (interaction.options.getSubcommand()) {
            case 'add': return subAdd(interaction, ctx);
            case 'remove': return subRemove(interaction, ctx);
            case 'list': return subList(interaction, ctx);
            default:
                return interaction.reply({ embeds: [error('Unknown subcommand', 'See /access list.')], flags: MessageFlags.Ephemeral });
        }
    }
};

async function subAdd(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const user = interaction.options.getUser('user', true);
    if (ctx.config.adminUserIds.has(user.id)) {
        return interaction.editReply({ embeds: [info('Already Authenticated', `<@${user.id}> is an administrator all along (set in ADMIN_USER_IDS).`)] });
    }
    await addAllowedUser(ctx.db, user.id);
    await ctx.db.audit('access_granted', {
        actor: interaction.user.id,
        target: user.id,
        details: { via: 'discord' }
    });
    return interaction.editReply({
        embeds: [success('Access Granted', [
            `<@${user.id}> (\`${user.id}\`) can now use the bot.`,
            '',
            'Included: `/license`, `/hwid`, `/login`, `/server`, `/help`.',
            'Not included (admins only): `/admin`, `/system`, `/notifications`.',
            'Access applies immediately \u2014 no restart needed.'
        ].join('\n'))]
    });
}

async function subRemove(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const user = interaction.options.getUser('user', true);
    if (ctx.config.adminUserIds.has(user.id)) {
        return interaction.editReply({ embeds: [error('Cannot Revoke', `<@${user.id}> is an administrator. Remove them from ADMIN_USER_IDS in bot/.env instead.`)] });
    }
    await removeAllowedUser(ctx.db, user.id);
    await ctx.db.audit('access_revoked', {
        actor: interaction.user.id,
        target: user.id,
        details: { via: 'discord' }
    });
    return interaction.editReply({
        embeds: [success('Access Revoked', `<@${user.id}> (\`${user.id}\`) can no longer use the bot. Takes effect within a minute.`)]
    });
}

async function subList(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const list = await ctx.db.getSetting('allowedUsers', []);
    const granted = Array.isArray(list) ? list : [];
    const admins = [...ctx.config.adminUserIds];
    const embed = {
        color: COLORS.primary,
        title: 'Bot Access',
        timestamp: new Date().toISOString(),
        footer: { text: 'LicenseManagerTGG' }
    };
    embed.fields = [
        {
            name: `Administrators (${admins.length})`,
            value: admins.map((id) => `<@${id}> \u2014 full access`).join('\n') || 'None configured (ADMIN_USER_IDS).',
            inline: false
        },
        {
            name: `Granted users (${granted.length})`,
            value: granted.map((id) => `<@${id}> \u2014 normal commands only`).join('\n') || 'None yet \u2014 use `/access add user:@them`.',
            inline: false
        }
    ];
    return interaction.editReply({ embeds: [embed] });
}
