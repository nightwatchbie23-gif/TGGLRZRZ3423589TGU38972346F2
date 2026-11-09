'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const api = require('../services/api');
const { COLORS, base, error, fmtDate, info, maskKey, success } = require('../utils/format');

const DATA = new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Administrative tools')
    .addSubcommand((sc) => sc.setName('stats').setDescription('License and ban statistics'))
    .addSubcommand((sc) => sc
        .setName('logs')
        .setDescription('Recent audit logs')
        .addIntegerOption((opt) => opt.setName('page').setDescription('Page number')))
    .addSubcommand((sc) => sc.setName('permissions').setDescription('Show authorized administrators'))
    .addSubcommand((sc) => sc
        .setName('maintenance')
        .setDescription('Toggle maintenance mode')
        .addBooleanOption((opt) => opt.setName('enabled').setDescription('Enable or disable').setRequired(true))
        .addStringOption((opt) => opt.setName('reason').setDescription('Reason shown in maintenance responses')))
    .addSubcommand((sc) => sc
        .setName('backup')
        .setDescription('Export licenses to a local JSON backup'))
    .addSubcommand((sc) => sc
        .setName('client-version')
        .setDescription('View or set the expected TGGLR client version')
        .addStringOption((opt) => opt.setName('version').setDescription('Expected version (e.g. 1.2.0; omit to view)')));

module.exports = {
    data: DATA,
    async execute(interaction, ctx) {
        switch (interaction.options.getSubcommand()) {
            case 'stats': return subStats(interaction, ctx);
            case 'logs': return subLogs(interaction, ctx);
            case 'permissions': return subPermissions(interaction, ctx);
            case 'maintenance': return subMaintenance(interaction, ctx);
            case 'backup': return subBackup(interaction, ctx);
            case 'client-version': return subClientVersion(interaction, ctx);
            default:
                return interaction.reply({ embeds: [error('Unknown subcommand', 'See /admin stats.')], flags: MessageFlags.Ephemeral });
        }
    }
};

async function countByStatus(ctx, status) {
    const result = await api.listLicenses(ctx.config, { limit: 1, status });
    return result.total || 0;
}

async function subStats(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const [all, active, disabled, expired, lifetime] = await Promise.all([
        countByStatus(ctx, 'all'),
        countByStatus(ctx, 'active'),
        countByStatus(ctx, 'disabled'),
        countByStatus(ctx, 'expired'),
        countByStatus(ctx, 'lifetime')
    ]);
    const bans = await ctx.db.listBans({ limit: 1 });
    const alerts = await ctx.db.listAlerts({ limit: 1 });

    const embed = base('Statistics', COLORS.primary);
    embed.fields = [
        { name: 'Total licenses', value: String(all), inline: true },
        { name: 'Active', value: String(active), inline: true },
        { name: 'Disabled', value: String(disabled), inline: true },
        { name: 'Expired', value: String(expired), inline: true },
        { name: 'Lifetime', value: String(lifetime), inline: true },
        { name: 'Device bans', value: String(bans ? bans.total : 0), inline: true },
        { name: 'Sharing alerts', value: String(alerts ? alerts.total : 0), inline: true }
    ];
    return interaction.editReply({ embeds: [embed] });
}

async function subLogs(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const pageSize = 10;
    const page = Math.max(1, interaction.options.getInteger('page') || 1);
    const result = await ctx.db.listAudit({ limit: pageSize, offset: (page - 1) * pageSize });
    const rows = result ? result.rows : [];
    const total = result ? result.total : 0;

    const embed = base(`Audit Logs \u2014 page ${page}`, COLORS.primary);
    embed.description = rows.map((row) =>
        `\`${row.event_type}\` by \`${row.actor || 'system'}\`${row.target ? ` \u2014 \`${maskKey(row.target)}\`` : ''} \u2014 ${fmtDate(row.created_at)}`
    ).join('\n') || 'No audit entries.';
    embed.fields = [{ name: 'Total entries', value: String(total), inline: true }];
    return interaction.editReply({ embeds: [embed] });
}

async function subPermissions(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const ids = [...ctx.config.adminUserIds];
    const embed = base('Authorized Administrators', COLORS.primary);
    embed.description = ids.length > 0
        ? ids.map((id) => `<@${id}> (${id})`).join('\n')
        : 'None configured. Set ADMIN_USER_IDS in bot/.env and restart.';
    embed.fields = [{ name: 'Count', value: String(ids.length), inline: true }];
    return interaction.editReply({ embeds: [embed] });
}

async function subMaintenance(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const enabled = interaction.options.getBoolean('enabled', true);
    const reason = interaction.options.getString('reason') || '';
    await ctx.db.setSetting('maintenance', { enabled, reason });
    await ctx.db.audit('maintenance_toggled', {
        actor: interaction.user.id,
        reason: reason || (enabled ? 'enabled' : 'disabled'),
        details: { enabled }
    });
    return interaction.editReply({
        embeds: [enabled
            ? success('Maintenance Mode ON', `Reason: ${reason || 'not specified'}\nAll bot commands are now paused until maintenance is disabled.`)
            : success('Maintenance Mode OFF', 'Bot commands are available again.')]
    });
}

async function subBackup(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const licenses = [];
    let offset = 0;
    while (offset < 5000) {
        const result = await api.listLicenses(ctx.config, { limit: 200, offset, status: 'all' });
        licenses.push(...(result.licenses || []));
        if ((result.licenses || []).length < 200) {
            break;
        }
        offset += 200;
    }

    const dir = path.join(__dirname, '..', '..', 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `licenses-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify({
        created_at: new Date().toISOString(),
        created_by: interaction.user.id,
        count: licenses.length,
        licenses
    }, null, 2));

    await ctx.db.audit('backup_created', {
        actor: interaction.user.id,
        details: { count: licenses.length, file: path.basename(file) }
    });

    const embed = success('Backup Created', [
        `${licenses.length} licenses exported.`,
        `Saved to: \`${path.relative(process.cwd(), file)}\``,
        'The file contains full license keys \u2014 keep it private and never commit it.'
    ].join('\n'));
    return interaction.editReply({ embeds: [embed] });
}

async function subClientVersion(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const version = interaction.options.getString('version');
    if (version) {
        await ctx.db.setSetting('client_version', version.trim());
        await ctx.db.audit('client_version_set', {
            actor: interaction.user.id,
            details: { version: version.trim() }
        });
        return interaction.editReply({ embeds: [success('Client Version Set', `Expected TGGLR version is now \`${version.trim()}\`. Mismatching clients are flagged in login notifications.`)] });
    }
    const current = await ctx.db.getSetting('client_version');
    return interaction.editReply({
        embeds: [current
            ? info('Expected Client Version', `Current: \`${current}\``)
            : info('Expected Client Version', 'Not set. Use `/admin client-version version:<v>` to flag clients reporting a different version.')]
    });
}
