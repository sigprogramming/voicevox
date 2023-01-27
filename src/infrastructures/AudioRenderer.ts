class Timer {
  private timeoutId?: number;

  constructor(interval: number, callback: () => void) {
    const tick = () => {
      callback();
      this.timeoutId = window.setTimeout(tick, interval);
    };
    tick();
  }

  dispose() {
    window.clearTimeout(this.timeoutId);
    this.timeoutId = undefined;
  }
}

type SoundEvent = {
  readonly time: number;
  readonly schedule: (contextTime: number) => void;
};

export interface SoundSequence {
  generateSoundEvents(startTime: number): SoundEvent[];
  scheduleStop(contextTime: number): void;
}

class SoundEventScheduler {
  readonly sequence: SoundSequence;

  private _isScheduling = false;

  private startContextTime = 0;
  private startTime = 0;
  private events: SoundEvent[] = [];
  private index = 0;

  get isScheduling() {
    return this._isScheduling;
  }

  constructor(sequence: SoundSequence) {
    this.sequence = sequence;
  }

  startScheduling(contextTime: number, time: number) {
    if (this._isScheduling) {
      throw new Error("Already started.");
    }

    this._isScheduling = true;
    this.startContextTime = contextTime;
    this.startTime = time;
    this.events = this.sequence.generateSoundEvents(time);
    this.index = 0;
  }

  scheduleEvents(contextTime: number, period: number) {
    if (!this._isScheduling) {
      throw new Error("Scheduling has not been started.");
    }
    if (contextTime < this.startContextTime) {
      throw new Error("The specified context time is invalid.");
    }

    const elapsedTime = contextTime - this.startContextTime;
    const time = this.startTime + elapsedTime;

    while (this.index < this.events.length) {
      const event = this.events[this.index];
      const timeUntilEvent = event.time - time;
      const eventContextTime = contextTime + timeUntilEvent;

      if (event.time < time + period) {
        event.schedule(eventContextTime);
        this.index++;
      } else break;
    }
  }

  stopScheduling(contextTime: number) {
    if (!this._isScheduling) {
      throw new Error("Scheduling has not been started.");
    }

    this.sequence.scheduleStop(contextTime);
    this._isScheduling = false;
  }
}

type LoopEvent = {
  readonly contextTime: number;
  readonly timeBeforeLoop: number;
  readonly timeAfterLoop: number;
};

export class Transport {
  private readonly audioContext: AudioContext;
  private readonly timer: Timer;
  private readonly lookAhead: number;

  private _state: "started" | "stopped" = "stopped";
  private _time = 0;
  public loop = false;
  public loopStartTime = 0;
  public loopEndTime = 0;
  private schedulers: SoundEventScheduler[] = [];

  private startContextTime = 0;
  private startTime = 0;
  private scheduledContextTime = 0;
  private schedulersToBeStopped: SoundEventScheduler[] = [];
  private scheduledLoopEvents: LoopEvent[] = [];

  get state() {
    return this._state;
  }

  get time() {
    if (this._state === "started") {
      const contextTime = this.audioContext.currentTime;
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

  constructor(audioContext: AudioContext, interval: number, lookAhead: number) {
    if (lookAhead <= interval) {
      throw new Error("Look-ahead time must be longer than the interval.");
    }

    this.audioContext = audioContext;
    this.lookAhead = lookAhead;
    this.timer = new Timer(interval * 1000, () => {
      if (this._state === "started") {
        const contextTime = this.audioContext.currentTime;
        this.scheduleEvents(contextTime);
      }
    });
  }

  private calculateTime(contextTime: number) {
    if (contextTime >= this.startContextTime) {
      const elapsedTime = contextTime - this.startContextTime;
      return this.startTime + elapsedTime;
    }
    while (this.scheduledLoopEvents.length !== 0) {
      const loopEvent = this.scheduledLoopEvents[0];
      if (contextTime < loopEvent.contextTime) {
        const timeUntilLoop = loopEvent.contextTime - contextTime;
        return loopEvent.timeBeforeLoop - timeUntilLoop;
      }
      this.scheduledLoopEvents.shift();
    }
    throw new Error("Loop events are not scheduled correctly.");
  }

  private scheduleSoundEvents(contextTime: number, time: number) {
    this.schedulersToBeStopped.forEach((value) => {
      value.stopScheduling(contextTime);
    });
    this.schedulersToBeStopped = [];

    this.schedulers.forEach((value) => {
      if (contextTime < this.startContextTime) {
        if (!value.isScheduling) {
          value.startScheduling(this.startContextTime, this.startTime);
          value.scheduleEvents(this.startContextTime, this.lookAhead);
        }
      } else {
        if (!value.isScheduling) {
          value.startScheduling(contextTime, time);
        }
        value.scheduleEvents(contextTime, this.lookAhead);
      }
    });
  }

  private scheduleLoopEvents(contextTime: number) {
    if (
      !this.loop ||
      this.loopEndTime <= this.loopStartTime ||
      this.startTime >= this.loopEndTime
    ) {
      return;
    }

    const timeUntilLoop = this.loopEndTime - this.startTime;
    let contextTimeToLoop = this.startContextTime + timeUntilLoop;
    if (contextTimeToLoop < this.scheduledContextTime) {
      return;
    }
    if (contextTimeToLoop < contextTime) {
      contextTimeToLoop = contextTime;
    }

    const loopDuration = this.loopEndTime - this.loopStartTime;

    while (
      contextTimeToLoop >= contextTime &&
      contextTimeToLoop < contextTime + this.lookAhead
    ) {
      this.scheduledLoopEvents.push({
        contextTime: contextTimeToLoop,
        timeBeforeLoop: this.loopEndTime,
        timeAfterLoop: this.loopStartTime,
      });

      this.startContextTime = contextTimeToLoop;
      this.startTime = this.loopStartTime;

      this.schedulers.forEach((value) => {
        if (value.isScheduling) {
          value.stopScheduling(this.startContextTime);
        }
        value.startScheduling(this.startContextTime, this.startTime);
        value.scheduleEvents(this.startContextTime, this.lookAhead);
      });

      contextTimeToLoop += loopDuration;
    }
  }

  private scheduleEvents(contextTime: number) {
    const time = this.calculateTime(contextTime);

    this.scheduleSoundEvents(contextTime, time);
    this.scheduleLoopEvents(contextTime);

    this.scheduledContextTime = contextTime + this.lookAhead;
  }

  addSequence(sequence: SoundSequence) {
    const exists = this.schedulers.some((value) => {
      return value.sequence === sequence;
    });
    if (exists) {
      throw new Error("The specified sequence has already been added.");
    }
    const scheduler = new SoundEventScheduler(sequence);
    this.schedulers.push(scheduler);
  }

  replaceSequence(sequence: SoundSequence, newSequence: SoundSequence) {
    const index = this.schedulers.findIndex((value) => {
      return value.sequence === sequence;
    });
    if (index === -1) {
      throw new Error("The specified sequence does not exist.");
    }
    const removedScheduler = this.schedulers.splice(index, 1)[0];
    if (removedScheduler.isScheduling) {
      this.schedulersToBeStopped.push(removedScheduler);
    }
    const scheduler = new SoundEventScheduler(newSequence);
    this.schedulers.push(scheduler);
  }

  removeSequence(sequence: SoundSequence) {
    const index = this.schedulers.findIndex((value) => {
      return value.sequence === sequence;
    });
    if (index === -1) {
      throw new Error("The specified sequence does not exist.");
    }
    const removedScheduler = this.schedulers.splice(index, 1)[0];
    if (removedScheduler.isScheduling) {
      const contextTime = this.audioContext.currentTime;
      removedScheduler.stopScheduling(contextTime);
    }
  }

  start() {
    if (this._state === "started") return;
    const contextTime = this.audioContext.currentTime;

    this._state = "started";

    this.startContextTime = contextTime;
    this.startTime = this._time;
    this.scheduledContextTime = this.startContextTime;
    this.schedulersToBeStopped = [];
    this.scheduledLoopEvents = [];

    this.scheduleEvents(this.startContextTime);
  }

  stop() {
    if (this._state === "stopped") return;
    const contextTime = this.audioContext.currentTime;
    this._time = this.calculateTime(contextTime);

    this._state = "stopped";

    this.schedulers.forEach((value) => {
      if (value.isScheduling) {
        value.stopScheduling(contextTime);
      }
    });
    this.schedulersToBeStopped.forEach((value) => {
      value.stopScheduling(contextTime);
    });
  }

  dispose() {
    if (this.state === "started") {
      this.stop();
    }
    this.timer.dispose();
  }
}

export class OfflineTransport {
  private schedulers: SoundEventScheduler[] = [];

  addSequence(sequence: SoundSequence) {
    const exists = this.schedulers.some((value) => {
      return value.sequence === sequence;
    });
    if (exists) {
      throw new Error("The specified sequence has already been added.");
    }
    const scheduler = new SoundEventScheduler(sequence);
    this.schedulers.push(scheduler);
  }

  replaceSequence(sequence: SoundSequence, newSequence: SoundSequence) {
    const index = this.schedulers.findIndex((value) => {
      return value.sequence === sequence;
    });
    if (index === -1) {
      throw new Error("The specified sequence does not exist.");
    }
    const newScheduler = new SoundEventScheduler(newSequence);
    this.schedulers.splice(index, 1, newScheduler);
  }

  removeSequence(sequence: SoundSequence) {
    const index = this.schedulers.findIndex((value) => {
      return value.sequence === sequence;
    });
    if (index === -1) {
      throw new Error("The specified sequence does not exist.");
    }
    this.schedulers.splice(index, 1);
  }

  scheduleEvents(startTime: number, period: number) {
    this.schedulers.forEach((value) => {
      value.startScheduling(0, startTime);
      value.scheduleEvents(0, period);
      value.stopScheduling(period);
    });
  }
}

export type AudioEvent = {
  readonly time: number;
  readonly buffer: AudioBuffer;
};

export class AudioSequence implements SoundSequence {
  private readonly audioPlayer: AudioPlayer;
  private readonly audioEvents: AudioEvent[];

  constructor(audioPlayer: AudioPlayer, audioEvents: AudioEvent[]) {
    this.audioPlayer = audioPlayer;
    this.audioEvents = audioEvents;
  }

  generateSoundEvents(startTime: number): SoundEvent[] {
    return this.audioEvents
      .filter((value) => {
        const audioEndTime = value.time + value.buffer.duration;
        return audioEndTime > startTime;
      })
      .map((value) => {
        const offset = Math.max(startTime - value.time, 0);
        return {
          time: Math.max(value.time, startTime),
          schedule: (contextTime: number) => {
            this.audioPlayer.play(contextTime, offset, value.buffer);
          },
        };
      });
  }

  scheduleStop(contextTime: number) {
    this.audioPlayer.allStop(contextTime);
  }
}

export interface Instrument {
  connect(destination: AudioNode): void;
  noteOn(contextTime: number, midi: number): void;
  noteOff(contextTime: number, midi: number): void;
  allStop(contextTime?: number): void;
}

export type NoteEvent = {
  readonly noteOnTime: number;
  readonly noteOffTime: number;
  readonly midi: number;
};

export class NoteSequence implements SoundSequence {
  private readonly instrument: Instrument;
  private readonly noteEvents: NoteEvent[];

  constructor(instrument: Instrument, noteEvents: NoteEvent[]) {
    this.instrument = instrument;
    this.noteEvents = noteEvents;
  }

  generateSoundEvents(startTime: number): SoundEvent[] {
    return this.noteEvents
      .filter((value) => value.noteOffTime > startTime)
      .map((value) => [
        {
          time: Math.max(value.noteOnTime, startTime),
          schedule: (contextTime: number) => {
            this.instrument.noteOn(contextTime, value.midi);
          },
        },
        {
          time: value.noteOffTime,
          schedule: (contextTime: number) => {
            this.instrument.noteOff(contextTime, value.midi);
          },
        },
      ])
      .flat()
      .sort((a, b) => a.time - b.time);
  }

  scheduleStop(contextTime: number): void {
    this.instrument.allStop(contextTime);
  }
}

class AudioPlayerVoice {
  private readonly audioBufferSourceNode: AudioBufferSourceNode;
  private readonly buffer: AudioBuffer;

  private _isStopped = false;
  private stopContextTime?: number;

  get isStopped() {
    return this._isStopped;
  }

  constructor(audioContext: BaseAudioContext, buffer: AudioBuffer) {
    this.audioBufferSourceNode = audioContext.createBufferSource();
    this.audioBufferSourceNode.buffer = buffer;
    this.audioBufferSourceNode.onended = () => {
      this._isStopped = true;
    };
    this.buffer = buffer;
  }

  connect(inputNode: AudioNode) {
    this.audioBufferSourceNode.connect(inputNode);
  }

  start(contextTime: number, offset: number) {
    this.stopContextTime = contextTime + this.buffer.duration;
    this.audioBufferSourceNode.start(contextTime, offset);
  }

  stop(contextTime: number) {
    if (this.stopContextTime === undefined) {
      throw new Error("Not started.");
    }
    if (contextTime < this.stopContextTime) {
      this.stopContextTime = contextTime;
      this.audioBufferSourceNode.stop(contextTime);
    }
  }

  dispose() {
    this.stopContextTime = 0;
    this.audioBufferSourceNode.stop();
  }
}

export type AudioPlayerOptions = {
  readonly volume: number;
};

export class AudioPlayer {
  private readonly audioContext: BaseAudioContext;
  private readonly gainNode: GainNode;

  private voices: AudioPlayerVoice[] = [];

  constructor(context: Context, options: AudioPlayerOptions = { volume: 0.1 }) {
    this.audioContext = context.audioContext;

    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = options.volume;
  }

  connect(destination: AudioNode) {
    this.gainNode.disconnect();
    this.gainNode.connect(destination);
  }

  disconnect() {
    this.gainNode.disconnect();
  }

  play(contextTime: number, offset: number, buffer: AudioBuffer) {
    const voice = new AudioPlayerVoice(this.audioContext, buffer);
    this.voices = this.voices.filter((value) => {
      return !value.isStopped;
    });
    this.voices.push(voice);
    voice.connect(this.gainNode);
    voice.start(contextTime, offset);
  }

  allStop(contextTime?: number) {
    if (contextTime === undefined) {
      this.voices.forEach((value) => {
        value.dispose();
      });
      this.voices = [];
    } else {
      this.voices.forEach((value) => {
        value.stop(contextTime);
      });
    }
  }

  dispose() {
    this.allStop();
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

class SynthVoice {
  readonly midi: number;
  private readonly oscillatorNode: OscillatorNode;
  private readonly gainNode: GainNode;
  private readonly envelope: Envelope;

  private _isActive = false;
  private _isStopped = false;
  private stopContextTime?: number;

  get isActive() {
    return this._isActive;
  }

  get isStopped() {
    return this._isStopped;
  }

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

  connect(inputNode: AudioNode) {
    this.gainNode.connect(inputNode);
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
    this._isActive = true;
  }

  noteOff(contextTime: number) {
    if (
      this.stopContextTime === undefined ||
      contextTime < this.stopContextTime
    ) {
      this.stopContextTime = contextTime;
      this._isActive = false;

      const t0 = contextTime;
      const rel = this.envelope.release;

      this.gainNode.gain.cancelAndHoldAtTime(t0);
      this.gainNode.gain.setTargetAtTime(0, t0, rel);

      this.oscillatorNode.stop(t0 + rel * 4);
    }
  }

  dispose() {
    this.stopContextTime = 0;
    this.oscillatorNode.stop();
    this._isActive = false;
  }
}

export type SynthOptions = {
  readonly volume: number;
  readonly oscillatorType: OscillatorType;
  readonly envelope: Envelope;
};

export class Synth implements Instrument {
  private readonly audioContext: BaseAudioContext;
  private readonly gainNode: GainNode;
  private readonly oscillatorType: OscillatorType;
  private readonly envelope: Envelope;

  private voices: SynthVoice[] = [];

  constructor(
    context: Context,
    options: SynthOptions = {
      volume: 0.1,
      oscillatorType: "square",
      envelope: {
        attack: 0.001,
        decay: 0.1,
        sustain: 0.7,
        release: 0.02,
      },
    }
  ) {
    this.audioContext = context.audioContext;

    this.oscillatorType = options.oscillatorType;
    this.envelope = options.envelope;
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = options.volume;
  }

  connect(destination: AudioNode) {
    this.gainNode.disconnect();
    this.gainNode.connect(destination);
  }

  disconnect() {
    this.gainNode.disconnect();
  }

  noteOn(contextTime: number, midi: number) {
    const exists = this.voices.some((value) => {
      return value.isActive && value.midi === midi;
    });
    if (exists) return;

    const voice = new SynthVoice(this.audioContext, {
      midi,
      oscillatorType: this.oscillatorType,
      envelope: this.envelope,
    });
    this.voices = this.voices.filter((value) => {
      return !value.isStopped;
    });
    this.voices.push(voice);
    voice.connect(this.gainNode);
    voice.noteOn(contextTime);
  }

  noteOff(contextTime: number, midi: number) {
    const voice = this.voices.find((value) => {
      return value.isActive && value.midi === midi;
    });
    if (voice === undefined) return;

    voice.noteOff(contextTime);
  }

  allStop(contextTime?: number) {
    if (contextTime === undefined) {
      this.voices.forEach((value) => {
        value.dispose();
      });
      this.voices = [];
    } else {
      this.voices.forEach((value) => {
        value.noteOff(contextTime);
      });
    }
  }

  dispose() {
    this.allStop();
  }
}

export type Context = {
  readonly audioContext: BaseAudioContext;
  readonly transport: Transport | OfflineTransport;
};

export class AudioRenderer {
  private readonly onlineContext: {
    readonly audioContext: AudioContext;
    readonly transport: Transport;
  };

  get context(): Context {
    return {
      audioContext: this.onlineContext.audioContext,
      transport: this.onlineContext.transport,
    };
  }

  get transport() {
    return this.onlineContext.transport;
  }

  constructor() {
    const audioContext = new AudioContext();
    const transport = new Transport(audioContext, 0.2, 0.6);
    this.onlineContext = { audioContext, transport };
  }

  renderToBuffer(
    startTime: number,
    duration: number,
    callback: (context: Context) => void
  ) {
    if (this.onlineContext.transport.state === "started") {
      this.onlineContext.transport.stop();
    }

    const sampleRate = this.context.audioContext.sampleRate;
    const length = sampleRate * duration;
    const audioContext = new OfflineAudioContext(2, length, sampleRate);
    const transport = new OfflineTransport();

    callback({ audioContext, transport });
    transport.scheduleEvents(startTime, duration);
    return audioContext.startRendering();
  }

  dispose() {
    this.onlineContext.transport.dispose();
    this.onlineContext.audioContext.close();
  }
}
