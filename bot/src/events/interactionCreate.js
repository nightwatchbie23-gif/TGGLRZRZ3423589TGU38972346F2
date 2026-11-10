'use strict';

const { Events, MessageFlags } = require('discord.js');
const { isAdmin, isAllowed, isMaintenance, isRateLimited, maintenanceMessage } = require('../utils/guards');
const { error } = require('../utils/format');
const { takePendingAction } = require('../utils/pending');
const { handleDashboardInteraction } = require('../services/dashboard');

const { handleLogsButton } = require('../commands/license');

async function onInteractionCreate(ctx, interaction) {
    try {
        if (interaction.isButton() && interaction.customId.startsWith('confirm:')) {
            return handleConfirmButton(interaction);
        }

        if ((interaction.isButton() || interaction.isModalSubmit()) && interaction.customId.startsWith('dash')) {
            return handleDashboardInteraction(ctx, interaction);
        }

        if (interaction.isButton() && interaction.customId.startsWith('logs:')) {
            return handleLogsButton(ctx, interaction);
        }

        if (interaction.isButton() && interaction.customId.startsWith('sharing:')) {
            return handleSharingButton(ctx, interaction);
        }

        if (interaction.isButton() && interaction.customId.startsWith('licdash:')) {
            return ctx.licenseDashboard.handleInteraction(interaction, ctx);
        }

        if (interaction.isModalSubmit() && interaction.customId === 'licdashCreateModal') {
            return ctx.licenseDashboard.handleModalSubmit(interaction, ctx);
        }

        if (!interaction.isChatInputCommand()) {
            return;
        }

        if (isRateLimited(interaction.user.id)) {
            return replyEphemeral(interaction, error('Slow Down', 'Too many commands. Try again in a few seconds.'));
        }

        const command = ctx.commands.get(interaction.commandName);

        if (!command) {
            return replyEphemeral(interaction, error('Unknown Command', 'That command is not registered.'));
        }

        // /help and /register are public (register is self-service binding);
        // everything else needs admin or granted access.
        const isPublic = interaction.commandName === 'help' || interaction.commandName === 'register';
        const authorized = isPublic
            || await isAllowed(ctx.config, ctx.db, interaction.user.id, interaction.commandName);
        if (!authorized) {
            const blocked = ['admin', 'system', 'notifications'].includes(interaction.commandName);
            return replyEphemeral(interaction, error(
                'Not Authorized',
                blocked
                    ? 'This command is for administrators only.'
                    : 'You are not allowed to use this bot. Ask an administrator to grant access with /access add.'
            ));
        }

        if (interaction.commandName !== 'help' && await isMaintenance(ctx.db)) {
            return replyEphemeral(interaction, error('Maintenance', await maintenanceMessage(ctx.db)));
        }

        await command.execute(interaction, ctx);
    } catch (err) {
        console.error(`Command "${interaction.commandName}" failed:`, err);
        const embed = error('Something Went Wrong', err.message || 'Unexpected error.');
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ embeds: [embed], components: [] }).catch(() => {});
        } else {
            await replyEphemeral(interaction, embed);
        }
    }
}

async function handleSharingButton(ctx, interaction) {
    if (!isAdmin(ctx.config, interaction.user.id)) {
        return interaction.reply({ embeds: [error('Not Authorized', 'Only administrators can decide sharing alerts.')], flags: MessageFlags.Ephemeral });
    }

    const [, action, alertIdRaw] = interaction.customId.split(':');
    const alertId = Number(alertIdRaw);
    await interaction.deferUpdate();

    try {
        if (action === 'confirm') {
            const decided = await ctx.monitors.confirmAlert(alertId, interaction.user.id);
            if (!decided) {
                return interaction.editReply({ components: [] });
            }
            await interaction.editReply({
                components: [],
                embeds: [{
                    color: 0xc8a2c8,
                    title: 'Alert Confirmed',
                    description: `Alert #${alertId} confirmed by <@${interaction.user.id}>. The license has been disabled through the backend.`,
                    timestamp: new Date().toISOString(),
                    footer: { text: 'LicenseManagerTGG' }
                }]
            });
        } else if (action === 'dismiss') {
            const decided = await ctx.monitors.dismissAlert(alertId, interaction.user.id);
            if (!decided) {
                return interaction.editReply({ components: [] });
            }
            await interaction.editReply({
                components: [],
                embeds: [{
                    color: 0x95a5a6,
                    title: 'Alert Dismissed',
                    description: `Alert #${alertId} dismissed by <@${interaction.user.id}>. Review the activity if it repeats.`,
                    timestamp: new Date().toISOString(),
                    footer: { text: 'LicenseManagerTGG' }
                }]
            });
        }
    } catch (err) {
        console.error('Sharing button failed:', err);
        await interaction.editReply({ components: [] }).catch(() => {});
    }
}

async function handleConfirmButton(interaction) {
    if (interaction.customId === 'confirm:cancel') {
        await interaction.deferUpdate();
        return interaction.editReply({ components: [], embeds: [error('Cancelled', 'No changes were made.')] });
    }

    const handler = takePendingAction(interaction.customId);
    if (!handler) {
        return interaction.reply({ embeds: [error('Expired', 'This confirmation has expired. Run the command again.')], flags: MessageFlags.Ephemeral });
    }
    await handler(interaction);
}

function replyEphemeral(interaction, embed) {
    const options = { embeds: [embed], flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) {
        return interaction.editReply({ embeds: [embed] });
    }
    return interaction.reply(options);
}

module.exports = { onInteractionCreate };
