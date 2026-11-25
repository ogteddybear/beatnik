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
import type { TextBasedChannel, VoiceBasedChannel } from "discord.js";

import { createVoiceConnection } from "./connection";
import { deleteVoiceSession } from "./manager";
import { getNowPlayingEmbed } from "./messaging";

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

  constructor(
    voiceChannel: VoiceBasedChannel,
    textChannel: TextBasedChannel | null,
    corePlayer: CorePlayer,
    actor?: { userId: string; username: string },
  ) {
    this.guildId = voiceChannel.guildId;
    this.textChannel = textChannel;
    this.connection = createVoiceConnection(voiceChannel);
    this.subscription = this.connection.subscribe(this.audioPlayer);
    trackVoiceLifecycle(this.connection, this.guildId, voiceChannel, actor);
    corePlayer.onVolume = (percent) => {
      this.resource?.volume?.setVolumeDecibels(this.normalizationDb);
      if (this.resource?.volume)
        this.resource.volume.setVolume((this.resource.volume.volume * percent) / 100);
    };

    corePlayer.onStream = async (track, inputStream) => {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 10_000);
      const { stream, type } = await demuxProbe(inputStream);
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

      const operator = decibels >= 0 ? "+" : "";
      log({
        component: "DISCORD",
        name: "VoiceSession",
        message: `Playing resource, adjusted loudness ${operator}${decibels}dB`,
      });

      // send embed in textchannel
      if (this.textChannel && this.textChannel.isSendable() && corePlayer.queue.nowPlaying) {
        const nowPlayingEmbed = getNowPlayingEmbed(
          corePlayer.queue.nowPlaying,
          corePlayer.queue.currentIndex + 1,
          corePlayer.queue.tracks.length,
          corePlayer.fromCache,
        );
        this.textChannel.send({ embeds: [nowPlayingEmbed] });
      }
    };

    corePlayer.onQueueEnd = () => {
      if (this.textChannel?.isSendable()) {
        this.textChannel.send(":wave: Nothing left in the queue!");
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
        this.textChannel.send(message);
      }
    };

    this.audioPlayer.on(AudioPlayerStatus.Idle, () => corePlayer.next());
    this.audioPlayer.on("error", (err) => {
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
    this.subscription?.unsubscribe();
    this.connection.destroy();
  }
}
