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
        .addStringOption((opt) => opt.setName('version').setDescription('Expected version (e.g. 1.2.0; omit to view)')))
    .addSubcommand((sc) => sc
        .setName('autobackup')
        .setDescription('Configure the daily automatic license backup')
        .addStringOption((opt) => opt.setName('setting').setDescription('What to view or change').addChoices(
            { name: 'Status', value: 'status' },
            { name: 'Enable', value: 'enable' },
            { name: 'Disable', value: 'disable' },
            { name: 'Channel', value: 'channel' },
            { name: 'Hour (UTC)', value: 'hour' },
            { name: 'Run now', value: 'runnow' }
        ).setRequired(false))
        .addChannelOption((opt) => opt.setName('channel').setDescription('Backup channel (omit = admin DMs)'))
        .addIntegerOption((opt) => opt.setName('hour').setDescription('UTC hour 0-23')))
    .addSubcommand((sc) => sc
        .setName('restore')
        .setDescription('Recreate licenses from a backup JSON file')
        .addAttachmentOption((opt) => opt.setName('file').setDescription('Backup .json file').setRequired(true)));

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
            case 'autobackup': return subAutoBackup(interaction, ctx);
            case 'restore': return subRestore(interaction, ctx);
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

async function subAutoBackup(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const setting = interaction.options.getString('setting') || 'status';
    const backup = require('../services/backup');
    const settings = await ctx.db.getSetting(backup.SETTINGS_KEY, {}) || {};

    if (setting === 'enable' || setting === 'disable') {
        settings.enabled = setting === 'enable';
        await ctx.db.setSetting(backup.SETTINGS_KEY, settings);
        await ctx.db.audit('autobackup_config', { actor: interaction.user.id, details: { enabled: settings.enabled } });
        return interaction.editReply({ embeds: [success('Auto Backup', settings.enabled ? 'Daily backups are ON.' : 'Daily backups are OFF.')] });
    }
    if (setting === 'channel') {
        const channel = interaction.options.getChannel('channel');
        settings.channelId = channel ? channel.id : null;
        await ctx.db.setSetting(backup.SETTINGS_KEY, settings);
        return interaction.editReply({
            embeds: [channel
                ? success('Backup Channel Set', `Backups will be posted in <#${channel.id}> (locked admins-only channels are safest \u2014 the file contains all keys).`)
                : info('Backup Channel Cleared', 'Backups will be sent by DM to administrators.')]
        });
    }
    if (setting === 'hour') {
        const hour = interaction.options.getInteger('hour');
        if (hour === null || hour < 0 || hour > 23) {
            return interaction.editReply({ embeds: [error('Invalid Hour', 'Hour must be 0\u201323 (UTC).')] });
        }
        settings.hour = hour;
        await ctx.db.setSetting(backup.SETTINGS_KEY, settings);
        return interaction.editReply({ embeds: [success('Hour Set', `The daily backup will run at UTC ${String(hour).padStart(2, '0')}:00 (once per day, caught up if the bot was off).`)] });
    }
    if (setting === 'runnow') {
        const result = await backup.runBackup(ctx, { manual: true });
        return interaction.editReply({
            embeds: [result.delivered
                ? success('Backup Sent', `${result.count} licenses \u2192 ${result.target}.`)
                : error('Not Delivered', `Backup contains ${result.count} licenses but delivery failed: ${result.target}`)]
        });
    }
    // status (default view)
    const lastRunAt = settings.lastRun ? `<t:${Math.floor(new Date(settings.lastRun).getTime() / 1000)}:R>` : 'never';
    return interaction.editReply({
        embeds: [info('Automatic Backup', [
            `State: ${settings.enabled === false ? '\u274C OFF' : '\u2705 ON'}`,
            `Time: UTC ${String(settings.hour ?? '03').padStart(2, '0')}:00 daily`,
            `Target: ${settings.channelId ? `<#${settings.channelId}>` : 'admin DMs'}`,
            `Last run: ${lastRunAt}`,
            '',
            'Change with `/admin autobackup setting:...` \u2014 local copies are also kept in `bot/backups/`.'
        ].join('\n'))]
    });
}

async function subRestore(interaction, ctx) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const attachment = interaction.options.getAttachment('file', true);
    try {
        const response = await fetch(attachment.url);
        const payload = JSON.parse(await response.text());
        const licenses = Array.isArray(payload) ? payload : payload.licenses;
        if (!Array.isArray(licenses) || licenses.length === 0) {
            return interaction.editReply({ embeds: [error('Invalid File', 'No licenses array found in that file.')] });
        }
        // Skip keys that still exist.
        const existing = new Set();
        let offset = 0;
        while (offset < 50000) {
            const result = await api.listLicenses(ctx.config, { limit: 200, offset, status: 'all' });
            const rows = result.licenses || [];
            for (const row of rows) {
                existing.add(row.license_key);
            }
            if (rows.length < 200) {
                break;
            }
            offset += 200;
        }

        let created = 0;
        let skipped = 0;
        let failed = 0;
        for (const license of licenses) {
            if (!license.license_key || existing.has(license.license_key)) {
                skipped += 1;
                continue;
            }
            // The backend generates keys on create; restored copies keep the
            // original expiry. Recreating by expiry is the supported path.
            try {
                const copy = await api.createLicense(ctx.config, {
                    expiresAt: license.expires_at || new Date(Date.now() + 365 * 86400 * 1000).toISOString()
                });
                if (license.discord_user_id ?? license.discordUserId) {
                    await ctx.db.updateLicenseMetadata(copy.license_key, {
                        discordUserId: license.discord_user_id ?? license.discordUserId,
                        minecraftUsername: license.minecraft_username ?? license.minecraftUsername
                    }).catch(() => {});
                }
                created += 1;
            } catch {
                failed += 1;
            }
        }
        await ctx.db.audit('licenses_restored', { actor: interaction.user.id, details: { created, skipped, failed } });
        return interaction.editReply({
            embeds: [success('Restore Finished', [
                `Created: **${created}**`,
                `Skipped (already exist): ${skipped}`,
                failed > 0 ? `\u26A0\uFE0F Failed: ${failed}` : '',
                '\u2139\uFE0F Restored copies get **new keys** (the backend generates them) \u2014 re-send owners their new key with `/license list`.'
            ].filter(Boolean).join('\n'))]
        });
    } catch (error_) {
        return interaction.editReply({ embeds: [error('Restore Failed', error_.message)] });
    }
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
