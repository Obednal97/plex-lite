// Browser playback for the web build (docs/WEB.md, "Playback"): what this browser can decode, the
// client profile sent to the Plex transcoder, and attaching a stream to the <video> element (HLS
// through the vendored hls.js, or the browser's own HLS in Safari). js/screens/player.js calls it
// through PL.webMedia; the TV build doesn't load this file and plays everything with video.src.
'use strict';

(function () {
  if (!PL.isWeb) return;
  var Hls = window.Hls;
  var probe = document.createElement('video');

  function can(type) {
    try { return /probably|maybe/.test(probe.canPlayType(type)); } catch (e) { return false; }
  }

  // Codec strings per Plex codec name; the first is what we test for.
  var VIDEO = {
    h264: 'avc1.640028', hevc: 'hvc1.1.6.L120.90', vp9: 'vp09.00.40.08', av1: 'av01.0.08M.08',
  };
  var VIDEO_10BIT = { hevc: 'hvc1.2.4.L120.90', vp9: 'vp09.02.40.10', av1: 'av01.0.08M.10' };
  var AUDIO = {
    aac: 'mp4a.40.2', mp3: 'mp4a.6B', opus: 'opus', flac: 'flac', ac3: 'ac-3', eac3: 'ec-3',
  };
  // Plex container names -> the MIME type a <video> element would see
  var CONTAINER = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska' };

  var caps = (function () {
    var c = { containers: [], video: [], video10: [], audio: [] };
    Object.keys(CONTAINER).forEach(function (k) {
      var type = CONTAINER[k];
      var ok = k === 'webm' ? can(type + '; codecs="vp9"') || can(type + '; codecs="vp8"')
        : k === 'mkv' ? can(type + '; codecs="avc1.640028"') : can(type + '; codecs="avc1.640028"');
      if (ok) c.containers.push(k);
    });
    Object.keys(VIDEO).forEach(function (k) {
      var type = (k === 'vp9' || k === 'av1') && !can('video/mp4; codecs="' + VIDEO[k] + '"') ? 'video/webm' : 'video/mp4';
      if (can(type + '; codecs="' + VIDEO[k] + '"')) c.video.push(k);
      if (VIDEO_10BIT[k] && can(type + '; codecs="' + VIDEO_10BIT[k] + '"')) c.video10.push(k);
    });
    Object.keys(AUDIO).forEach(function (k) {
      if (can('video/mp4; codecs="avc1.640028, ' + AUDIO[k] + '"') || (k === 'mp3' && can('audio/mpeg'))) c.audio.push(k);
    });
    return c;
  })();

  var nativeHls = can('application/vnd.apple.mpegurl');
  var hlsJs = !!(Hls && Hls.isSupported && Hls.isSupported());
  // Safari (and iOS, which has no MediaSource) plays HLS itself; everyone else uses hls.js
  var isSafari = /Safari/.test(navigator.userAgent) && !/Chrome|CriOS|Edg|Firefox|Android/.test(navigator.userAgent);
  var useNative = nativeHls && (isSafari || !hlsJs);

  function has(list, x) { return list.indexOf(x) !== -1; }

  function streamsOf(media) {
    var part = media && media.Part && media.Part[0];
    return (part && part.Stream) || [];
  }

  // Whether this browser can play the file as it is (no server work). media: a Plex Media entry.
  // Returns null when it can, else the reason it can't.
  function directPlayProblem(media) {
    if (!media) return 'no media';
    var container = String(media.container || '').toLowerCase();
    if (!has(caps.containers, container)) return 'container ' + container;
    var streams = streamsOf(media);
    var v = streams.filter(function (s) { return s.streamType === 1; })[0];
    var a = streams.filter(function (s) { return s.streamType === 2; })[0]; // direct play gets the first track
    var vc = String((v && v.codec) || media.videoCodec || '').toLowerCase();
    var bits = Number((v && v.bitDepth) || 8);
    if (!has(caps.video, vc)) return 'video ' + vc;
    if (bits > 8 && (vc === 'h264' || !has(caps.video10, vc))) return 'video ' + vc + ' ' + bits + '-bit';
    var ac = String((a && a.codec) || media.audioCodec || '').toLowerCase();
    if (ac && !has(caps.audio, ac)) return 'audio ' + ac;
    return null;
  }

  // The client profile for the decision and the stream: what we play directly (so the server never
  // "direct plays" something we can't decode), and the HLS we want otherwise: H.264 in MPEG-TS
  // (hls.js and Safari both take it) with stereo AAC. vtt: also serve text subtitles as WebVTT
  // (the player draws them itself, as on the TV).
  function profileExtra(vtt) {
    var dp = caps.containers.length && caps.video.length ? [
      'add-direct-play-profile(type=videoProfile&container=' + caps.containers.join(',') + '&videoCodec=' + caps.video.join(',') +
        '&audioCodec=' + caps.audio.join(',') + ')',
    ] : [];
    var audio = has(caps.audio, 'mp3') ? 'aac,mp3' : 'aac';
    return dp.concat([
      'add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=h264&audioCodec=' + audio + ')',
      'add-limitation(scope=videoCodec&scopeName=h264&type=upperBound&name=video.bitDepth&value=8)',
      'add-limitation(scope=videoAudioCodec&scopeName=aac&type=upperBound&name=audio.channels&value=2)',
    ]).concat(vtt ? ['add-transcode-target(type=subtitleProfile&context=streaming&protocol=hls&container=webvtt&subtitleCodec=webvtt)'] : [])
      .join('+');
  }

  // Quality for the route to the server: the Plex relay is slow (about 2 Mbit/s), so ask for 720p
  // there; LAN and Remote Access get the original quality.
  function quality(server) {
    var kind = server && server.kind;
    if (kind === 'relay') return { location: 'wan', maxVideoBitrate: 2000, videoResolution: '1280x720', maxDirectKbps: 2000 };
    if (kind === 'lan' || kind === 'manual-local') return { location: 'lan', maxVideoBitrate: 200000, videoResolution: '3840x2160', maxDirectKbps: 0 };
    return { location: 'wan', maxVideoBitrate: 200000, videoResolution: '3840x2160', maxDirectKbps: 0 };
  }

  // ---- Attaching a stream ------------------------------------------------------------------------

  // url: a file (direct play) or an HLS playlist. onFatal(message) when hls.js gives up.
  function attach(video, url, isHls, onFatal) {
    detach(video);
    video.setAttribute('playsinline', '');
    if (!isHls || useNative || !hlsJs) {
      if (isHls && !nativeHls && !hlsJs) {
        setTimeout(function () { onFatal('This browser can\'t play streams (no HLS or Media Source support)'); }, 0);
        return;
      }
      video.src = url;
      return;
    }
    var hls = new Hls({
      enableWorker: true,
      liveDurationInfinity: true, // a live channel's buffer shows as video.seekable (pause and rewind)
      backBufferLength: 120,
      maxBufferLength: 30,
      // the transcoder writes segments as it goes: be patient with a fresh session
      manifestLoadPolicy: { default: { maxTimeToFirstByteMs: 20000, maxLoadTimeMs: 30000, timeoutRetry: { maxNumRetry: 4, retryDelayMs: 500, maxRetryDelayMs: 2000 }, errorRetry: { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 4000 } } },
      playlistLoadPolicy: { default: { maxTimeToFirstByteMs: 20000, maxLoadTimeMs: 30000, timeoutRetry: { maxNumRetry: 4, retryDelayMs: 500, maxRetryDelayMs: 2000 }, errorRetry: { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 4000 } } },
      fragLoadPolicy: { default: { maxTimeToFirstByteMs: 30000, maxLoadTimeMs: 60000, timeoutRetry: { maxNumRetry: 6, retryDelayMs: 500, maxRetryDelayMs: 4000 }, errorRetry: { maxNumRetry: 8, retryDelayMs: 1000, maxRetryDelayMs: 4000 } } },
    });
    var recovered = 0;
    hls.on(Hls.Events.ERROR, function (event, data) {
      if (!data || !data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recovered < 2) {
        recovered++;
        PL.warn('hls media error, recovering', data.details);
        hls.recoverMediaError();
        return;
      }
      PL.warn('hls fatal', data.type, data.details, data.response && data.response.code);
      onFatal(data.details || data.type);
    });
    hls.loadSource(url);
    hls.attachMedia(video);
    video.plHls = hls;
  }

  function detach(video) {
    var hls = video.plHls;
    if (!hls) return;
    video.plHls = null;
    try { hls.destroy(); } catch (e) { /* already gone */ }
  }

  PL.webMedia = {
    caps: caps,
    hls: useNative ? 'native' : hlsJs ? 'hls.js ' + Hls.version : 'none',
    directPlayProblem: directPlayProblem,
    profileExtra: profileExtra,
    quality: quality,
    attach: attach,
    detach: detach,
  };
  PL.log('web media', JSON.stringify({ containers: caps.containers, video: caps.video, video10: caps.video10, audio: caps.audio, hls: PL.webMedia.hls }));
})();
