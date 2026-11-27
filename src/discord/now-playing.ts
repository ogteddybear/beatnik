import type { CorePlayer } from "@/core/player";
import type { PlayerState } from "@/core/player";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type MessageCreateOptions,
  type MessageEditOptions,
  escapeMarkdown,
} from "discord.js";

import { proxyImageUrl } from "../utils/image-proxy";

export function playbackTime(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

export function nowPlayingPayload(state: PlayerState) {
  if (state.isLive) {
    return {
      embeds: [
        new EmbedBuilder()
          .setColor("#0a203b")
          .setAuthor({ name: state.status === "loading" ? "🔴 LIVE · Connecting…" : "🔴 LIVE" })
          .setTitle(state.track.title.slice(0, 256))
          .setDescription(
            `${escapeMarkdown(state.track.artist)}\nUse \`/stop\` to end the broadcast.`,
          ),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId("player:stop")
            .setLabel("Stop")
            .setStyle(ButtonStyle.Danger),
        ),
      ],
      allowedMentions: { parse: [] as [] },
    };
  }
  const filled = Math.max(0, Math.min(20, Math.round(state.progressPercent / 5)));
  const embed = new EmbedBuilder()
    .setColor("#0a203b")
    .setAuthor({
      name:
        state.status === "paused"
          ? "Paused on Sashimi"
          : state.status === "loading"
            ? "Loading on Sashimi"
            : "Now playing on Sashimi",
    })
    .setTitle(state.track.title.slice(0, 256))
    .setDescription(
      `${escapeMarkdown(state.track.artist.slice(0, 256) || "Unknown artist")}\n\n\`[${"█".repeat(filled)}${"░".repeat(20 - filled)}]\`\n${playbackTime(state.progressSeconds)} / ${state.track.durationSeconds ? playbackTime(state.track.durationSeconds) : "Live"} · Loop: ${state.loopMode}`,
    );
  if (/^https?:\/\//i.test(state.track.thumbnail))
    embed.setThumbnail(proxyImageUrl(state.track.thumbnail));
  const disabled = state.status === "loading";
  const components = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("player:pause")
        .setEmoji("⏯️")
        .setLabel(state.status === "paused" ? "Resume" : "Pause")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId("player:skip")
        .setEmoji("⏭️")
        .setLabel("Skip")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId("player:loop")
        .setEmoji("🔁")
        .setLabel(`Loop: ${state.loopMode}`)
        .setStyle(state.loopMode === "off" ? ButtonStyle.Secondary : ButtonStyle.Primary)
        .setDisabled(disabled),
    ),
  ];
  return { embeds: [embed], components, allowedMentions: { parse: [] as [] } };
}

interface PanelMessage {
  id: string;
  edit(payload: MessageEditOptions): Promise<unknown>;
}
interface PanelChannel {
  send(payload: MessageCreateOptions): Promise<PanelMessage>;
}

// Serialize edits so a slow initial send cannot produce duplicate panels, or a
// late periodic update re-enable buttons after teardown.
export class NowPlayingPanel {
  private message?: PanelMessage;
  private pending = Promise.resolve();
  private closed = false;
  private lastLiveEdit = 0;
  private lastLiveStation?: string;
  constructor(
    private channel: PanelChannel,
    private player: CorePlayer,
  ) {}

  isCurrentMessage(id: string): boolean {
    return !this.closed && this.message?.id === id;
  }

  refresh(): Promise<void> {
    this.pending = this.pending
      .then(async () => {
        if (this.closed) return;
        const state = this.player.getState();
        if (!state) return;
        if (
          state.isLive &&
          this.message &&
          this.lastLiveStation === state.track.id &&
          Date.now() - this.lastLiveEdit < 60_000
        )
          return;
        const payload = nowPlayingPayload(state);
        this.lastLiveEdit = state.isLive ? Date.now() : 0;
        this.lastLiveStation = state.isLive ? state.track.id : undefined;
        if (this.message) {
          try {
            await this.message.edit(payload);
            return;
          } catch (error) {
            if (!error || typeof error !== "object" || !("code" in error) || error.code !== 10008)
              throw error;
            this.message = undefined; // Deleted message: replace it once.
          }
        }
        this.message = await this.channel.send(payload);
      })
      .catch(() => {
        console.warn("Unable to update the Discord player panel.");
      });
    return this.pending;
  }

  close(): Promise<void> {
    this.closed = true;
    this.pending = this.pending
      .then(async () => {
        if (this.message)
          await this.message.edit({
            embeds: [new EmbedBuilder().setColor("#0a203b").setTitle("Playback ended")],
            components: [],
          });
      })
      .catch(() => {
        console.warn("Unable to close the Discord player panel.");
      });
    return this.pending;
  }
}
