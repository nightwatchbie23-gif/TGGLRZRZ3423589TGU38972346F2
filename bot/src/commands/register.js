'use strict';

const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const api = require('../services/api');
const { error, info, maskKey, success, warn } = require('../utils/format');

// PUBLIC self-service command: the license owner binds their own Discord
// account to the license they received. After binding, player cards show
// their Discord identity automatically; admins never touch it.
// The Minecraft username is NOT asked for: the client auto-detects it from
// the game and the backend stores it on every /api/verify.

const DATA = new SlashCommandBuilder()
    .setName('register')
    .setDescription('Bind your Discord account to your TGGLR license (with the key you received by DM)')
    .addStringOption((opt) => opt
        .setName('key')
        .setDescription('Your license key (sent to you by DM when it was created)')
        .setRequired(true));

module.exports = {
    data: DATA,
    async execute(interaction, ctx) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const key = interaction.options.getString('key', true).trim();
        const user = interaction.user;

        let license;
        try {
            license = await api.findLicenseByKey(ctx.config, key);
        } catch (error_) {
            return interaction.editReply({ embeds: [warn('Verification Unavailable', error_.message)] });
        }
        if (!license) {
            return interaction.editReply({
                embeds: [error('Invalid License Key', 'That is not a valid license key. Use the exact key you received by DM.')]
            });
        }

        const metadata = await ctx.db.findLicenseMetadata(license.license_key).catch(() => null);
        const currentOwner = metadata && metadata.discord_user_id ? String(metadata.discord_user_id) : null;

        if (currentOwner && currentOwner !== user.id) {
            // Nobody may silently take over a bound license.
            return interaction.editReply({
                embeds: [warn('Already Bound', 'This license is already bound to a Discord account. If the account must change, an administrator can do `/license transfer`.')]
            });
        }
        if (currentOwner === user.id) {
            return interaction.editReply({
                embeds: [info('Already Yours', `License \`${maskKey(license.license_key)}\` is already bound to your account. Your Minecraft username updates automatically when you play with the client.`)]
            });
        }

        await ctx.db.updateLicenseMetadata(license.license_key, { discordUserId: user.id });
        await ctx.db.audit('license_selfbound', {
            actor: user.id,
            target: license.license_key,
            details: { via: 'register command' }
        });

        // Refresh the player card (if a board exists) so it shows their name.
        if (ctx.players) {
            try {
                const logins = await ctx.players.latestLogins();
                await ctx.players.upsertCard(ctx, license, logins.get(license.license_key) || null);
            } catch { /* board unavailable \u2014 non-critical */ }
        }

        return interaction.editReply({
            embeds: [success('Account Bound', [
                `Your Discord account is now linked to \`${maskKey(license.license_key)}\`.`,
                '',
                '\u2705 Player cards now show your Discord identity.',
                '\u2705 Your Minecraft username is detected automatically from the game \u2014 nothing to type.',
                license.expires_at ? `Expires: ${license.expires_at.slice(0, 10)}` : 'Lifetime license.'
            ].join('\n'))]
        });
    }
};
