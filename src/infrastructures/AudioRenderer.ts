class Timer {
  private timeoutId?: number;
  private tickListeners = new Set<() => void>();

  constructor(interval: number) {
    const tick = () => {
      this.tickListeners.forEach((value) => value());
      this.timeoutId = window.setTimeout(tick, interval);
    };
    tick();
  }

  addTickListener(listener: () => void) {
    if (this.tickListeners.has(listener)) {
      throw new Error("The listener has already been added.");
    }
    this.tickListeners.add(listener);
  }

  removeTickListener(listener: () => void) {
    if (!this.tickListeners.has(listener)) {
      throw new Error("The listener does not exist.");
    }
    this.tickListeners.delete(listener);
  }

  dispose() {
    if (this.timeoutId !== undefined) {
      window.clearTimeout(this.timeoutId);
      this.timeoutId = undefined;
    }
  }
}

export type AudioSequence = {
  readonly type: "audio";
  readonly audioPlayer: AudioPlayer;
  readonly audioEvents: AudioEvent[];
};

export type NoteSequence = {
  readonly type: "note";
  readonly instrument: Instrument;
  readonly noteEvents: NoteEvent[];
};

export type Sequence = AudioSequence | NoteSequence;

interface EventScheduler {
  start(contextTime: number, time: number): void;
  schedule(untilTime: number): void;
  stop(contextTime: number): void;
}

/**
 * 登録されているシーケンスのイベントをスケジュールし、再生を行います。
 */
export class Transport {
  private readonly context: Context;
  private readonly tickListener: () => void;

  private _state: "started" | "stopped" = "stopped";
  private _time = 0;
  private sequences = new Set<Sequence>();

  private startContextTime = 0;
  private startTime = 0;
  private schedulers = new Map<Sequence, EventScheduler>();

  get state() {
    return this._state;
  }

  get time() {
    if (this._state === "started") {
      const audioContext = this.context.audioContext;
      const contextTime = audioContext.currentTime;
      this._time = this.calculateTime(contextTime);
    }
    return this._time;
  }

  set time(value: number) {
    if (this._state === "started") {
      this.stop();
      this._time = value;
      this.start();
    } else {
      this._time = value;
    }
  }

  constructor(context: Context) {
    this.context = context;
    this.tickListener = () => {
      if (this._state === "started") {
        const audioContext = this.context.audioContext;
        const contextTime = audioContext.currentTime;
        this.schedule(contextTime);
      }
    };
    this.context.timer.addTickListener(this.tickListener);
  }

  private calculateTime(contextTime: number) {
    const elapsedTime = contextTime - this.startContextTime;
    return this.startTime + elapsedTime;
  }

  private createScheduler(sequence: Sequence) {
    let scheduler: EventScheduler | undefined;
    if (sequence.type === "audio") {
      scheduler = new AudioEventScheduler(
        sequence.audioPlayer,
        sequence.audioEvents
      );
    } else {
      scheduler = new NoteEventScheduler(
        sequence.instrument,
        sequence.noteEvents
      );
    }
    return scheduler;
  }

  private schedule(contextTime: number) {
    const lookAhead = this.context.lookAhead;
    const time = this.calculateTime(contextTime);

    // シーケンスの削除を反映
    const removedSequences: Sequence[] = [];
    this.schedulers.forEach((scheduler, sequence) => {
      if (!this.sequences.has(sequence)) {
        scheduler.stop(contextTime);
        removedSequences.push(sequence);
      }
    });
    removedSequences.forEach((sequence) => {
      this.schedulers.delete(sequence);
    });

    // シーケンスの追加を反映
    this.sequences.forEach((sequence) => {
      if (!this.schedulers.has(sequence)) {
        const scheduler = this.createScheduler(sequence);
        scheduler.start(contextTime, time);
        this.schedulers.set(sequence, scheduler);
      }
    });

    this.schedulers.forEach((scheduler) => {
      scheduler.schedule(time + lookAhead);
    });
  }

  /**
   * シーケンスを追加します。再生中に追加した場合は、次のスケジューリングで反映されます。
   */
  addSequence(sequence: Sequence) {
    if (this.sequences.has(sequence)) {
      throw new Error("The sequence has already been added.");
    }
    this.sequences.add(sequence);
  }

  /**
   * シーケンスを削除します。再生中に削除した場合は、次のスケジューリングで反映されます。
   */
  removeSequence(sequence: Sequence) {
    if (!this.sequences.has(sequence)) {
      throw new Error("The sequence does not exist.");
    }
    this.sequences.delete(sequence);
  }

  start() {
    if (this._state === "started") return;
    const audioContext = this.context.audioContext;
    const contextTime = audioContext.currentTime;

    this._state = "started";

    this.startContextTime = contextTime;
    this.startTime = this._time;

    this.schedule(contextTime);
  }

  stop() {
    if (this._state === "stopped") return;
    const audioContext = this.context.audioContext;
    const contextTime = audioContext.currentTime;
    this._time = this.calculateTime(contextTime);

    this._state = "stopped";

    this.schedulers.forEach((value) => {
      value.stop(contextTime);
    });
    this.schedulers.clear();
  }

  dispose() {
    if (this.state === "started") {
      this.stop();
    }
    this.context.timer.removeTickListener(this.tickListener);
  }
}

/**
 * 登録されているシーケンスのイベントをスケジュールします。主に保存用途です。
 */
export class OfflineTransport {
  private schedulers = new Map<Sequence, EventScheduler>();

  private createScheduler(sequence: Sequence) {
    let scheduler: EventScheduler | undefined;
    if (sequence.type === "audio") {
      scheduler = new AudioEventScheduler(
        sequence.audioPlayer,
        sequence.audioEvents
      );
    } else {
      scheduler = new NoteEventScheduler(
        sequence.instrument,
        sequence.noteEvents
      );
    }
    return scheduler;
  }

  addSequence(sequence: Sequence) {
    if (this.schedulers.has(sequence)) {
      throw new Error("The sequence has already been added.");
    }
    const scheduler = this.createScheduler(sequence);
    this.schedulers.set(sequence, scheduler);
  }

  removeSequence(sequence: Sequence) {
    if (!this.schedulers.has(sequence)) {
      throw new Error("The sequence does not exist.");
    }
    this.schedulers.delete(sequence);
  }

  schedule(startTime: number, period: number) {
    this.schedulers.forEach((scheduler) => {
      scheduler.start(0, startTime);
      scheduler.schedule(period);
      scheduler.stop(period);
    });
  }
}

interface Voice {
  isStopped(): boolean;
}

export type AudioEvent = {
  readonly time: number;
  readonly buffer: AudioBuffer;
};

class AudioEventScheduler implements EventScheduler {
  private readonly player: AudioPlayer;
  private readonly events: AudioEvent[];

  private isStarted = false;
  private startContextTime = 0;
  private startTime = 0;
  private index = 0;
  private voices: Voice[] = [];

  constructor(audioPlayer: AudioPlayer, audioEvents: AudioEvent[]) {
    this.player = audioPlayer;
    this.events = [...audioEvents];
    this.events.sort((a, b) => a.time - b.time);
  }

  start(contextTime: number, time: number) {
    if (this.isStarted) {
      throw new Error("Already started.");
    }

    this.startContextTime = contextTime;
    this.startTime = time;
    this.index = this.events.length;
    this.voices = [];

    for (let i = 0; i < this.events.length; i++) {
      const event = this.events[i];
      if (event.time + event.buffer.duration > time) {
        this.index = i;
        break;
      }
    }

    this.isStarted = true;
  }

  schedule(untilTime: number) {
    if (!this.isStarted) {
      throw new Error("Not started.");
    }

    this.voices = this.voices.filter((value) => {
      return !value.isStopped();
    });
    while (this.index < this.events.length) {
      const event = this.events[this.index];
      const offset = Math.max(this.startTime - event.time, 0);
      const contextTime =
        this.startContextTime + (event.time + offset - this.startTime);

      if (event.time < untilTime) {
        const voice = this.player.play(contextTime, offset, event.buffer);
        this.voices.push(voice);
        this.index++;
      } else break;
    }
  }

  stop(contextTime: number) {
    if (!this.isStarted) {
      throw new Error("Not started.");
    }

    this.voices.forEach((value) => {
      this.player.stop(contextTime, value);
    });
  }
}

export interface Instrument {
  connect(destination: AudioNode): void;
  disconnect(): void;
  noteOn(contextTime: number, midi: number): Voice;
  noteOff(contextTime: number, midi: number): void;
  noteOff(contextTime: number, voice: Voice): void;
}

export type NoteEvent = {
  readonly noteOnTime: number;
  readonly noteOffTime: number;
  readonly midi: number;
};

class NoteEventScheduler implements EventScheduler {
  private readonly instrument: Instrument;
  private readonly events: NoteEvent[];

  private isStarted = false;
  private startContextTime = 0;
  private startTime = 0;
  private index = 0;
  private voices: Voice[] = [];

  constructor(instrument: Instrument, noteEvents: NoteEvent[]) {
    this.instrument = instrument;
    this.events = [...noteEvents];
    this.events.sort((a, b) => a.noteOnTime - b.noteOnTime);
  }

  start(contextTime: number, time: number) {
    if (this.isStarted) {
      throw new Error("Already started.");
    }

    this.startContextTime = contextTime;
    this.startTime = time;
    this.index = this.events.length;
    this.voices = [];

    for (let i = 0; i < this.events.length; i++) {
      if (this.events[i].noteOffTime > time) {
        this.index = i;
        break;
      }
    }

    this.isStarted = true;
  }

  schedule(untilTime: number) {
    if (!this.isStarted) {
      throw new Error("Not started.");
    }

    this.voices = this.voices.filter((value) => {
      return !value.isStopped();
    });
    while (this.index < this.events.length) {
      const event = this.events[this.index];
      const noteOnTime = Math.max(event.noteOnTime, this.startTime);
      const noteOnContextTime =
        this.startContextTime + (noteOnTime - this.startTime);
      const noteOffContextTime =
        this.startContextTime + (event.noteOffTime - this.startTime);

      if (event.noteOnTime < untilTime) {
        const voice = this.instrument.noteOn(noteOnContextTime, event.midi);
        this.instrument.noteOff(noteOffContextTime, event.midi);
        this.voices.push(voice);
        this.index++;
      } else break;
    }
  }

  stop(contextTime: number) {
    if (!this.isStarted) {
      throw new Error("Not started.");
    }

    this.voices.forEach((value) => {
      this.instrument.noteOff(contextTime, value);
    });
  }
}

class AudioPlayerVoice implements Voice {
  private readonly bufferSourceNode: AudioBufferSourceNode;
  private readonly buffer: AudioBuffer;

  private _isStopped = false;
  private stopContextTime?: number;

  constructor(audioContext: BaseAudioContext, buffer: AudioBuffer) {
    this.bufferSourceNode = audioContext.createBufferSource();
    this.bufferSourceNode.buffer = buffer;
    this.bufferSourceNode.onended = () => {
      this._isStopped = true;
    };
    this.buffer = buffer;
  }

  isStopped() {
    return this._isStopped;
  }

  connect(destination: AudioNode) {
    this.bufferSourceNode.connect(destination);
  }

  play(contextTime: number, offset: number) {
    this.bufferSourceNode.start(contextTime, offset);
    this.stopContextTime = contextTime + this.buffer.duration;
  }

  stop(contextTime: number) {
    if (this.stopContextTime === undefined) {
      throw new Error("Not started.");
    }
    if (contextTime === undefined || contextTime < this.stopContextTime) {
      this.bufferSourceNode.stop(contextTime);
      this.stopContextTime = contextTime;
    }
  }
}

export type AudioPlayerOptions = {
  readonly volume?: number;
};

export class AudioPlayer {
  private readonly audioContext: BaseAudioContext;
  private readonly gainNode: GainNode;

  private voices: AudioPlayerVoice[] = [];

  constructor(context: BaseContext, options?: AudioPlayerOptions) {
    this.audioContext = context.audioContext;

    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = options?.volume ?? 1.0;
  }

  connect(destination: AudioNode) {
    this.gainNode.connect(destination);
  }

  disconnect() {
    this.gainNode.disconnect();
  }

  play(contextTime: number, offset: number, buffer: AudioBuffer): Voice {
    this.voices = this.voices.filter((value) => {
      return !value.isStopped();
    });
    const voice = new AudioPlayerVoice(this.audioContext, buffer);
    voice.connect(this.gainNode);
    voice.play(contextTime, offset);
    this.voices.push(voice);
    return voice;
  }

  stop(contextTime: number, voice: Voice) {
    this.voices.forEach((value) => {
      if (value === voice) {
        value.stop(contextTime);
      }
    });
  }
}

export type Envelope = {
  readonly attack: number;
  readonly decay: number;
  readonly sustain: number;
  readonly release: number;
};

type SynthVoiceOptions = {
  readonly midi: number;
  readonly oscillatorType: OscillatorType;
  readonly envelope: Envelope;
};

class SynthVoice implements Voice {
  private readonly midi: number;
  private readonly oscillatorNode: OscillatorNode;
  private readonly gainNode: GainNode;
  private readonly envelope: Envelope;

  private _isStopped = false;
  private stopContextTime?: number;

  constructor(audioContext: BaseAudioContext, options: SynthVoiceOptions) {
    this.midi = options.midi;
    this.envelope = options.envelope;

    this.oscillatorNode = audioContext.createOscillator();
    this.oscillatorNode.onended = () => {
      this._isStopped = true;
    };
    this.gainNode = audioContext.createGain();
    this.oscillatorNode.type = options.oscillatorType;
    this.oscillatorNode.connect(this.gainNode);
  }

  private midiToFrequency(midi: number) {
    return 440 * 2 ** ((midi - 69) / 12);
  }

  isStopped() {
    return this._isStopped;
  }

  connect(destination: AudioNode) {
    this.gainNode.connect(destination);
  }

  noteOn(contextTime: number) {
    const t0 = contextTime;
    const atk = this.envelope.attack;
    const dcy = this.envelope.decay;
    const sus = this.envelope.sustain;

    this.gainNode.gain.value = 0;
    this.gainNode.gain.setValueAtTime(0, t0);
    this.gainNode.gain.linearRampToValueAtTime(1, t0 + atk);
    this.gainNode.gain.setTargetAtTime(sus, t0 + atk, dcy);

    const freq = this.midiToFrequency(this.midi);
    this.oscillatorNode.frequency.value = freq;

    this.oscillatorNode.start(contextTime);
  }

  noteOff(contextTime: number) {
    const t0 = contextTime;
    const rel = this.envelope.release;
    const stopContextTime = t0 + rel * 4;

    if (
      this.stopContextTime === undefined ||
      stopContextTime < this.stopContextTime
    ) {
      this.gainNode.gain.cancelAndHoldAtTime(t0);
      this.gainNode.gain.setTargetAtTime(0, t0, rel);

      this.oscillatorNode.stop(stopContextTime);

      this.stopContextTime = stopContextTime;
    }
  }
}

export type SynthOptions = {
  readonly volume?: number;
  readonly oscillatorType?: OscillatorType;
  readonly envelope?: Envelope;
};

/**
 * ポリフォニックなシンセサイザー。
 */
export class Synth implements Instrument {
  private readonly audioContext: BaseAudioContext;
  private readonly gainNode: GainNode;
  private readonly oscillatorType: OscillatorType;
  private readonly envelope: Envelope;

  private voices: SynthVoice[] = [];
  private assignedVoices = new Map<number, SynthVoice>();

  constructor(context: BaseContext, options?: SynthOptions) {
    this.audioContext = context.audioContext;

    this.oscillatorType = options?.oscillatorType ?? "square";
    this.envelope = options?.envelope ?? {
      attack: 0.001,
      decay: 0.1,
      sustain: 0.7,
      release: 0.02,
    };
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = options?.volume ?? 0.1;
  }

  connect(destination: AudioNode) {
    this.gainNode.connect(destination);
  }

  disconnect() {
    this.gainNode.disconnect();
  }

  noteOn(contextTime: number, midi: number): Voice {
    this.voices = this.voices.filter((value) => {
      return !value.isStopped();
    });
    let voice = this.assignedVoices.get(midi);
    if (voice) {
      return voice;
    }
    voice = new SynthVoice(this.audioContext, {
      midi,
      oscillatorType: this.oscillatorType,
      envelope: this.envelope,
    });
    voice.connect(this.gainNode);
    voice.noteOn(contextTime);
    this.voices.push(voice);
    this.assignedVoices.set(midi, voice);
    return voice;
  }

  noteOff(contextTime: number, midi: number): void;
  noteOff(contextTime: number, voice: Voice): void;
  noteOff(contextTime: number, arg: number | Voice) {
    if (typeof arg === "number") {
      const voice = this.assignedVoices.get(arg);
      if (voice) {
        voice.noteOff(contextTime);
        this.assignedVoices.delete(arg);
      }
    } else {
      const voice = this.voices.find((value) => {
        return value === arg;
      });
      if (voice) {
        voice.noteOff(contextTime);
      }
    }
  }
}

export type ChannelStripOptions = {
  readonly volume?: number;
};

export class ChannelStrip {
  private readonly gainNode: GainNode;

  get inputNode(): AudioNode {
    return this.gainNode;
  }

  get volume() {
    return this.gainNode.gain.value;
  }

  set volume(value: number) {
    this.gainNode.gain.value = value;
  }

  constructor(context: BaseContext, options?: ChannelStripOptions) {
    const audioContext = context.audioContext;
    this.gainNode = audioContext.createGain();
    this.gainNode.gain.value = options?.volume ?? 0.1;
  }

  connect(destination: AudioNode) {
    this.gainNode.connect(destination);
  }

  disconnect() {
    this.gainNode.disconnect();
  }
}

export interface BaseContext {
  readonly audioContext: BaseAudioContext;
  createAudioBuffer(blob: Blob): Promise<AudioBuffer>;
}

export class Context implements BaseContext {
  readonly audioContext: AudioContext;
  readonly destination: AudioDestinationNode;
  readonly timer: Timer;
  readonly lookAhead: number;

  constructor(scheduleInterval = 0.2, scheduleBufferTime = 0.4) {
    this.audioContext = new AudioContext();
    this.destination = this.audioContext.destination;
    this.timer = new Timer(scheduleInterval * 1000);
    this.lookAhead = scheduleInterval + scheduleBufferTime;
  }

  async createAudioBuffer(blob: Blob) {
    const arrayBuffer = await blob.arrayBuffer();
    return this.audioContext.decodeAudioData(arrayBuffer);
  }

  close() {
    this.timer.dispose();
    this.audioContext.close();
  }
}

/**
 * 音声書き出し用のコンテキストです。
 */
export class OfflineContext implements BaseContext {
  readonly audioContext: OfflineAudioContext;
  readonly destination: AudioDestinationNode;

  constructor(duration: number, sampleRate: number, numberOfChannels = 2) {
    this.audioContext = new OfflineAudioContext(
      numberOfChannels,
      sampleRate * duration,
      sampleRate
    );
    this.destination = this.audioContext.destination;
  }

  async createAudioBuffer(blob: Blob) {
    const arrayBuffer = await blob.arrayBuffer();
    return this.audioContext.decodeAudioData(arrayBuffer);
  }

  renderToBuffer() {
    return this.audioContext.startRendering();
  }
}
