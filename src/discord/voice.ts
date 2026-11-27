import { logEvent } from "@/core/db/guild-events";
import { deleteSession } from "@/core/manager";
import type { CorePlayer } from "@/core/player";
import { log } from "@/shared";
import type { AudioResource, PlayerSubscription, VoiceConnection } from "@discordjs/voice";
import {
  AudioPlayerStatus,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  demuxProbe,
  entersState,
} from "@discordjs/voice";
import type { Message, TextBasedChannel, VoiceBasedChannel } from "discord.js";

import { createVoiceConnection } from "./connection";
import { createLiveStreamHandler } from "./live-audio";
import { deleteVoiceSession } from "./manager";
import { NowPlayingPanel } from "./now-playing";

export function trackVoiceLifecycle(
  connection: { once(event: string, listener: () => void): unknown },
  guildId: string,
  channel: { id: string; name: string },
  actor?: { userId: string; username: string },
) {
  const record = (action: string) => {
    try {
      logEvent({
        guildId,
        ...(action === "join" ? actor : undefined),
        eventType: "voice",
        action,
        metadata: { channelId: channel.id, channelName: channel.name },
      });
    } catch (error) {
      console.error("Unable to record voice event:", error);
    }
  };
  connection.once(VoiceConnectionStatus.Ready, () => record("join"));
  connection.once(VoiceConnectionStatus.Destroyed, () => record("leave"));
}

export class VoiceSession {
  private guildId: string;
  private textChannel: TextBasedChannel | null;
  private audioPlayer = createAudioPlayer();
  private subscription?: PlayerSubscription;
  private connection: VoiceConnection;
  private resource?: AudioResource;
  private normalizationDb = 0;
  private panel?: NowPlayingPanel;
  private liveReplyPanel?: NowPlayingPanel;
  private panelTimer?: ReturnType<typeof setInterval>;
  private destroyed = false;
  private controlBusy = false;
  private trackFailed = false;
  readonly channelId: string;

  constructor(
    voiceChannel: VoiceBasedChannel,
    textChannel: TextBasedChannel | null,
    private readonly corePlayer: CorePlayer,
    actor?: { userId: string; username: string },
  ) {
    this.channelId = voiceChannel.id;
    this.guildId = voiceChannel.guildId;
    this.textChannel = textChannel;
    this.connection = createVoiceConnection(voiceChannel);
    this.subscription = this.connection.subscribe(this.audioPlayer);
    trackVoiceLifecycle(this.connection, this.guildId, voiceChannel, actor);
    this.connection.once(VoiceConnectionStatus.Destroyed, () => {
      if (!this.destroyed) {
        this.destroy();
        deleteVoiceSession(this.guildId);
        deleteSession(this.guildId);
      }
    });
    if (textChannel?.isSendable()) {
      this.panel = new NowPlayingPanel(textChannel, corePlayer);
    }
    this.panelTimer = setInterval(() => {
      void this.panel?.refresh();
      void this.liveReplyPanel?.refresh();
    }, 15_000);
    this.panelTimer.unref();
    corePlayer.onStateChange = () => {
      void this.panel?.refresh();
      void this.liveReplyPanel?.refresh();
    };
    corePlayer.onPause = (paused) =>
      paused ? this.audioPlayer.pause() : this.audioPlayer.unpause();
    corePlayer.onPosition = () => (this.resource?.playbackDuration ?? 0) / 1000;
    corePlayer.onVolume = (percent) => {
      this.resource?.volume?.setVolumeDecibels(this.normalizationDb);
      if (this.resource?.volume)
        this.resource.volume.setVolume((this.resource.volume.volume * percent) / 100);
    };

    corePlayer.onResetAudio = () => {
      this.audioPlayer.stop(true);
      this.resource?.playStream.destroy();
      this.resource = undefined;
    };
    corePlayer.onLiveStream = createLiveStreamHandler({
      audioPlayer: this.audioPlayer,
      ready: () => entersState(this.connection, VoiceConnectionStatus.Ready, 10_000),
      isDestroyed: () => this.destroyed,
      setResource: (resource) => {
        this.resource = resource;
        this.normalizationDb = 0;
        resource.volume?.setVolume(corePlayer.volume / 100);
      },
      resetResource: (resource) => {
        if (this.resource === resource) corePlayer.onResetAudio?.();
      },
      onStage: (stage) => {
        log({
          component: "DISCORD",
          name: "LIVE",
          message: `Guild ${this.guildId}: live playback stage=${stage}`,
        });
      },
    });
    corePlayer.onLiveUnavailable = (stationName) => {
      if (this.textChannel?.isSendable()) {
        void this.textChannel
          .send({
            content: `Cannot reach **${stationName}** right now. The station may be down. Try again later or use a different station.`,
            allowedMentions: { parse: [] },
          })
          .catch(console.error);
      }
    };

    corePlayer.onStream = async (track, inputStream, isCurrent, startPaused) => {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 10_000);
      if (this.destroyed || !isCurrent()) {
        inputStream.destroy();
        return;
      }
      const { stream, type } = await demuxProbe(inputStream);
      if (this.destroyed || !isCurrent()) {
        stream.destroy();
        return;
      }
      const resource = createAudioResource(stream, {
        inputType: type,
        inlineVolume: true,
      });
      const decibels = -(track.loudness ?? 0);
      this.resource = resource;
      this.normalizationDb = decibels;
      resource.volume?.setVolumeDecibels(decibels);
      if (resource.volume)
        resource.volume.setVolume((resource.volume.volume * corePlayer.volume) / 100);
      this.audioPlayer.play(resource);
      if (startPaused) {
        await entersState(this.audioPlayer, AudioPlayerStatus.Playing, 10_000);
        if (this.destroyed || !isCurrent()) {
          this.audioPlayer.stop();
          return;
        }
        this.audioPlayer.pause(false);
      }
      this.trackFailed = false;

      const operator = decibels >= 0 ? "+" : "";
      log({
        component: "DISCORD",
        name: "VoiceSession",
        message: `Playing resource, adjusted loudness ${operator}${decibels}dB`,
      });
    };

    corePlayer.onQueueEnd = () => {
      if (this.textChannel?.isSendable()) {
        void this.textChannel.send(":wave: Nothing left in the queue!").catch(console.error);
      }
      deleteVoiceSession(this.guildId);
      deleteSession(this.guildId);
    };

    corePlayer.onStop = () => {
      deleteVoiceSession(this.guildId);
      deleteSession(this.guildId);
    };

    corePlayer.onError = (track, err) => {
      // errors already throw/log elsewhere, just message the textChannel
      if (this.textChannel && this.textChannel.isSendable()) {
        const message = `Unable to play **${track.title}**\n\`\`\`${err.message}\`\`\``;
        void this.textChannel.send(message).catch(console.error);
      }
    };

    this.audioPlayer.on(AudioPlayerStatus.Idle, () => {
      if (!this.destroyed && !corePlayer.isLoading && corePlayer.isPlaying)
        void corePlayer.finish(this.trackFailed).catch(console.error);
    });
    this.audioPlayer.on("error", (err) => {
      if (corePlayer.isLive) {
        // A late error from an old resource must not restart a newer station.
        if (err.resource === this.resource) {
          log({
            level: "WARN",
            component: "DISCORD",
            name: "LIVE",
            message: `Guild ${this.guildId}: live audio failed: ${err.message}`,
          });
          void corePlayer.finish(true);
        }
        return;
      }
      this.trackFailed = true;
      const track = corePlayer.queue.nowPlaying;
      if (track) {
        try {
          logEvent({
            guildId: this.guildId,
            userId: track.addedBy,
            username: track.addedByUsername,
            eventType: "player_error",
            action: "voice",
            trackId: track.id,
            trackName: track.title,
            metadata: {
              providerId: track.providerId,
              errorName: err.name,
            },
          });
        } catch (logError) {
          console.error("Unable to record voice error event:", logError);
        }
        corePlayer.onError?.(track, err);
      }
    });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.corePlayer.suspend();
    if (this.panelTimer) clearInterval(this.panelTimer);
    void this.panel?.close();
    void this.closeLiveReply();
    this.audioPlayer.stop();
    this.resource?.playStream.destroy();
    this.subscription?.unsubscribe();
    if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) this.connection.destroy();
  }

  isCurrentMessage(messageId: string) {
    return (
      (this.panel?.isCurrentMessage(messageId) ?? false) ||
      (this.liveReplyPanel?.isCurrentMessage(messageId) ?? false)
    );
  }

  async closeLiveReply() {
    const panel = this.liveReplyPanel;
    this.liveReplyPanel = undefined;
    await panel?.close();
  }

  watchLiveReply(message: Message) {
    if (this.destroyed) return;
    this.liveReplyPanel = new NowPlayingPanel(null, this.corePlayer, message);
    void this.liveReplyPanel.refresh();
  }

  async runControl(action: () => Promise<void>): Promise<boolean> {
    if (this.destroyed || this.controlBusy) return false;
    this.controlBusy = true;
    try {
      await action();
      return true;
    } finally {
      this.controlBusy = false;
    }
  }
}
