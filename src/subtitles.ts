/* eslint no-redeclare: 0 */
/* global sessionStorage:writable */

import { configRead } from './config';
import {
  getPlayer,
  PlayerState,
  requireElement,
  type CaptionTrack
} from './player-api';
import { showNotification } from './ui';
import { waitForChildAdd } from './utils';

/**
 * Returns the length of the longest common prefix between `a` and `b`.
 */
function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) {
    i++;
  }
  return i;
}

function findByPrefix(
  languageCode: string,
  candidates?: CaptionTrack[]
): CaptionTrack | undefined {
  return candidates
    ?.map(
      (track) =>
        [track, commonPrefixLength(track.languageCode, languageCode)] as const
    )
    .sort(([_a, gcplA], [_b, gcplB]) => gcplB - gcplA)
    .filter(([_, gcpl]) => gcpl > 1)[0]?.[0];
}

enum CaptionKind {
  MANUAL = '',
  AUTOGEN = 'asr',
  TRANSLATED = 'translated'
}

interface FindTrackReturn {
  value: CaptionTrack;
  kind: CaptionKind;
}

let player = await getPlayer();

function findTrack(languageCode: string): FindTrackReturn | undefined {
  const tracks = player.getOption('captions', 'tracklist', {
    includeAsr: true
  });

  if (!tracks) return;

  const groups = Map.groupBy(tracks, (track) => track.kind);

  const manualTracks = groups.get('');
  let bestTrack = findByPrefix(languageCode, manualTracks);
  if (bestTrack) return { value: bestTrack, kind: CaptionKind.MANUAL };

  const autoTracks = groups.get('asr');
  bestTrack = findByPrefix(languageCode, autoTracks);
  if (bestTrack) return { value: bestTrack, kind: CaptionKind.AUTOGEN };

  const translatedTracks = player.getOption('captions', 'translationLanguages');
  bestTrack = findByPrefix(languageCode, translatedTracks);
  if (bestTrack) return { value: bestTrack, kind: CaptionKind.TRANSLATED };
}

function getSelectedLanguageCode(): string {
  const data = JSON.parse(
    sessionStorage.getItem('yt-player-caption-language-preferences') ?? '{}'
  ).data;

  return data ? JSON.parse(data)[0] : (navigator.language ?? 'en-US');
}

async function initSubtitle(selected: string, track: FindTrackReturn) {
  console.debug('[subtitles] Subtitle load:', selected, track);
  player.setOption('captions', 'track', track.value);

  const capContainer = await waitForChildAdd(
    document.body,
    (node): node is HTMLDivElement =>
      node instanceof HTMLDivElement &&
      node.classList.contains('ytp-caption-window-container'),
    false
  );

  const video = await requireElement('video', HTMLVideoElement);
  let dcTimerStarted = false;

  // Fight YT's auto-disable
  const obs = new MutationObserver(async (_) => {
    if (capContainer.children.length > 0) return; // Subtitles are still there

    console.debug('[subtitles] Subtitle re-enabled');
    player.toggleSubtitlesOn();

    if (!dcTimerStarted) {
      // Require 3 seconds of playback after the first auto-disable before stopping observation
      dcTimerStarted = true;

      const startTracking = () => {
        video.removeEventListener('timeupdate', startTracking);
        setTimeout(() => {
          console.debug('[subtitles] Stopped observing');
          obs.disconnect();
        }, 3000);
      };
      video.addEventListener('timeupdate', startTracking);
    }
  });

  obs.observe(capContainer, {
    childList: true
  });
}

let interval: number | undefined = undefined;
function intervalHandler(selected: string) {
  const track = findTrack(selected);
  if (!track) {
    return;
  }
  window.clearInterval(interval);
  interval = undefined;
  initSubtitle(selected, track);
}

function handlePlayerStateChange(state: PlayerState) {
  if (!configRead('stickySubtitles')) return;

  player.loadModule('captions');

  setTimeout(() => {
    switch (state) {
      case PlayerState.BUFFERING: {
        if (interval) {
          window.clearInterval(interval);
          interval = undefined;
        }

        const selected = getSelectedLanguageCode();

        // if (!track) {
        //   showNotification('Subtitles unavailable');
        //   break;
        // }

        interval = window.setInterval(intervalHandler, 250, selected);
        break;
      }
    }
  }, 0);
}

player.addEventListener('onStateChange', handlePlayerStateChange);
