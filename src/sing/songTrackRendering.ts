import {
  CacheableTask,
  NonCacheableTask,
  SkipCondition,
  Task,
  TaskGraph,
  TaskGraphRunner,
  TaskResultInfo,
} from "./taskGraphRunner";
import {
  EditorFrameAudioQuery,
  EditorFrameAudioQueryKey,
  PhraseKey,
  SingingPitch,
  SingingPitchKey,
  SingingVoice,
  SingingVoiceKey,
  SingingVolume,
  SingingVolumeKey,
} from "@/store/type";
import {
  calculateHash,
  getLast,
  getPrev,
  linearInterpolation,
} from "@/sing/utility";
import {
  applyPhonemeTimingEditAndAdjust,
  applyPitchEdit,
  calculatePhraseKey,
  decibelToLinear,
  getNoteDuration,
  secondToTick,
  tickToSecond,
} from "@/sing/domain";
import { FramePhoneme, Note as NoteForRequestToEngine } from "@/openapi";
import { EngineId, NoteId, StyleId, TrackId } from "@/type/preload";
import { getOrThrow } from "@/helpers/mapHelper";
import type { Note, Singer, Tempo, Track } from "@/domain/project/type";
import { ExhaustiveError, UnreachableError } from "@/type/utility";

/**
 * レンダリングに必要なデータのスナップショット
 */
export type SnapshotForRender = Readonly<{
  tpqn: number;
  tempos: Tempo[];
  tracks: Map<TrackId, Track>;
  trackOverlappingNoteIds: Map<TrackId, Set<NoteId>>;
  engineFrameRates: Map<EngineId, number>;
  editorFrameRate: number;
}>;

/**
 * レンダリング用のフレーズ
 */
export type PhraseForRender = {
  readonly singer: Singer | undefined;
  readonly firstRestDuration: number;
  readonly notes: Note[];
  readonly startTicks: number;
  readonly endTicks: number;
  readonly startTime: number;
  readonly trackId: TrackId;
  queryKey?: EditorFrameAudioQueryKey;
  query?: EditorFrameAudioQuery;
  phonemeTimingEditingAppliedQuery?: EditorFrameAudioQuery;
  singingPitchKey?: SingingPitchKey;
  singingPitch?: SingingPitch;
  singingVolumeKey?: SingingVolumeKey;
  singingVolume?: SingingVolume;
  singingVoiceKey?: SingingVoiceKey;
  singingVoice?: SingingVoice;
  errorOccurredDuringRendering: boolean;
};

/**
 * クエリの生成に必要なデータ
 */
type QuerySource = Readonly<{
  engineId: EngineId;
  engineFrameRate: number;
  tpqn: number;
  tempos: Tempo[];
  firstRestDuration: number;
  notes: Note[];
  keyRangeAdjustment: number;
}>;

/**
 * 歌唱ピッチの生成に必要なデータ
 */
type SingingPitchSource = Readonly<{
  engineId: EngineId;
  engineFrameRate: number;
  tpqn: number;
  tempos: Tempo[];
  firstRestDuration: number;
  notes: Note[];
  keyRangeAdjustment: number;
  queryForPitchGeneration: EditorFrameAudioQuery;
}>;

/**
 * 歌唱ボリュームの生成に必要なデータ
 */
type SingingVolumeSource = Readonly<{
  engineId: EngineId;
  engineFrameRate: number;
  tpqn: number;
  tempos: Tempo[];
  firstRestDuration: number;
  notes: Note[];
  keyRangeAdjustment: number;
  volumeRangeAdjustment: number;
  queryForVolumeGeneration: EditorFrameAudioQuery;
}>;

/**
 * 歌唱音声の合成に必要なデータ
 */
type SingingVoiceSource = Readonly<{
  singer: Singer;
  queryForSingingVoiceSynthesis: EditorFrameAudioQuery;
}>;

/**
 * エンジンの歌声合成API
 */
type EngineSongApi = Readonly<{
  fetchFrameAudioQuery: (args: {
    engineId: EngineId;
    styleId: StyleId;
    engineFrameRate: number;
    notes: NoteForRequestToEngine[];
  }) => Promise<EditorFrameAudioQuery>;

  fetchSingFrameF0: (args: {
    notes: NoteForRequestToEngine[];
    query: EditorFrameAudioQuery;
    engineId: EngineId;
    styleId: StyleId;
  }) => Promise<number[]>;

  fetchSingFrameVolume: (args: {
    notes: NoteForRequestToEngine[];
    query: EditorFrameAudioQuery;
    engineId: EngineId;
    styleId: StyleId;
  }) => Promise<number[]>;

  frameSynthesis: (args: {
    query: EditorFrameAudioQuery;
    engineId: EngineId;
    styleId: StyleId;
  }) => Promise<Blob>;
}>;

/**
 * ソングトラックのレンダリングの設定。
 */
type SongTrackRenderingConfig = Readonly<{
  singingTeacherStyleId: StyleId;
  firstRestMinDurationSeconds: number;
  lastRestDurationSeconds: number;
  fadeOutDurationSeconds: number;
}>;

/**
 * ソングトラックのレンダリングのコンテキスト。
 */
type SongTrackRenderingContext = Readonly<{
  snapshot: SnapshotForRender;
  phrases: Map<PhraseKey, PhraseForRender>;
}>;

type ReadonlySongTrackRenderingContext = Readonly<{
  snapshot: SnapshotForRender;
  phrases: ReadonlyMap<PhraseKey, PhraseForRender>;
}>;

/**
 * リクエスト用のノーツ（と休符）を作成する。
 */
const createNotesForRequestToEngine = (
  firstRestDuration: number,
  lastRestDurationSeconds: number,
  notes: Note[],
  tempos: Tempo[],
  tpqn: number,
  frameRate: number,
) => {
  const notesForRequestToEngine: NoteForRequestToEngine[] = [];

  // 先頭の休符を変換
  const firstRestStartSeconds = tickToSecond(
    notes[0].position - firstRestDuration,
    tempos,
    tpqn,
  );
  const firstRestStartFrame = Math.round(firstRestStartSeconds * frameRate);
  const firstRestEndSeconds = tickToSecond(notes[0].position, tempos, tpqn);
  const firstRestEndFrame = Math.round(firstRestEndSeconds * frameRate);
  notesForRequestToEngine.push({
    key: undefined,
    frameLength: firstRestEndFrame - firstRestStartFrame,
    lyric: "",
  });

  // ノートを変換
  for (const note of notes) {
    const noteOnSeconds = tickToSecond(note.position, tempos, tpqn);
    const noteOnFrame = Math.round(noteOnSeconds * frameRate);
    const noteOffSeconds = tickToSecond(
      note.position + note.duration,
      tempos,
      tpqn,
    );
    const noteOffFrame = Math.round(noteOffSeconds * frameRate);
    notesForRequestToEngine.push({
      id: note.id,
      key: note.noteNumber,
      frameLength: noteOffFrame - noteOnFrame,
      lyric: note.lyric,
    });
  }

  // 末尾に休符を追加
  const lastRestFrameLength = Math.round(lastRestDurationSeconds * frameRate);
  notesForRequestToEngine.push({
    key: undefined,
    frameLength: lastRestFrameLength,
    lyric: "",
  });

  // frameLengthが1以上になるようにする
  for (let i = 0; i < notesForRequestToEngine.length; i++) {
    const frameLength = notesForRequestToEngine[i].frameLength;
    const frameToShift = Math.max(0, 1 - frameLength);
    notesForRequestToEngine[i].frameLength += frameToShift;
    if (i < notesForRequestToEngine.length - 1) {
      notesForRequestToEngine[i + 1].frameLength -= frameToShift;
    }
  }

  return notesForRequestToEngine;
};

const shiftKeyOfNotes = (notes: NoteForRequestToEngine[], keyShift: number) => {
  for (const note of notes) {
    if (note.key != undefined) {
      note.key += keyShift;
    }
  }
};

const shiftPitch = (f0: number[], pitchShift: number) => {
  for (let i = 0; i < f0.length; i++) {
    f0[i] *= Math.pow(2, pitchShift / 12);
  }
};

const shiftVolume = (volume: number[], volumeShift: number) => {
  for (let i = 0; i < volume.length; i++) {
    volume[i] *= decibelToLinear(volumeShift);
  }
};

/**
 * 末尾のpauの区間のvolumeを0にする。（歌とpauの呼吸音が重ならないようにする）
 * fadeOutDurationSecondsが0の場合は即座にvolumeを0にする。
 */
const muteLastPauSection = (
  volume: number[],
  phonemes: FramePhoneme[],
  frameRate: number,
  fadeOutDurationSeconds: number,
) => {
  const lastPhoneme = phonemes.at(-1);
  if (lastPhoneme == undefined || lastPhoneme.phoneme !== "pau") {
    throw new Error("No pau exists at the end.");
  }

  let lastPauStartFrame = 0;
  for (let i = 0; i < phonemes.length - 1; i++) {
    lastPauStartFrame += phonemes[i].frameLength;
  }

  const lastPauFrameLength = lastPhoneme.frameLength;
  let fadeOutFrameLength = Math.round(fadeOutDurationSeconds * frameRate);
  fadeOutFrameLength = Math.max(0, fadeOutFrameLength);
  fadeOutFrameLength = Math.min(lastPauFrameLength, fadeOutFrameLength);

  // フェードアウト処理を行う
  if (fadeOutFrameLength === 1) {
    volume[lastPauStartFrame] *= 0.5;
  } else {
    for (let i = 0; i < fadeOutFrameLength; i++) {
      volume[lastPauStartFrame + i] *= linearInterpolation(
        0,
        1,
        fadeOutFrameLength - 1,
        0,
        i,
      );
    }
  }
  // 音量を0にする
  for (let i = fadeOutFrameLength; i < lastPauFrameLength; i++) {
    volume[lastPauStartFrame + i] = 0;
  }
};

const calculateQueryKey = async (querySource: QuerySource) => {
  const hash = await calculateHash(querySource);
  return EditorFrameAudioQueryKey(hash);
};

const calculateSingingPitchKey = async (
  singingPitchSource: SingingPitchSource,
) => {
  const hash = await calculateHash(singingPitchSource);
  return SingingPitchKey(hash);
};

const calculateSingingVolumeKey = async (
  singingVolumeSource: SingingVolumeSource,
) => {
  const hash = await calculateHash(singingVolumeSource);
  return SingingVolumeKey(hash);
};

const calculateSingingVoiceKey = async (
  singingVoiceSource: SingingVoiceSource,
) => {
  const hash = await calculateHash(singingVoiceSource);
  return SingingVoiceKey(hash);
};

const calcPhraseFirstRestDuration = (
  prevPhraseLastNote: Note | undefined,
  phraseFirstNote: Note,
  phraseFirstRestMinDurationSeconds: number,
  tempos: Tempo[],
  tpqn: number,
) => {
  const quarterNoteDuration = getNoteDuration(4, tpqn);
  let phraseFirstRestDuration: number | undefined = undefined;

  // 実際のフレーズ先頭の休符の長さを調べる
  if (prevPhraseLastNote == undefined) {
    if (phraseFirstNote.position === 0) {
      // 1小節目の最初から始まっているフレーズの場合は、
      // とりあえず4分音符の長さをフレーズ先頭の休符の長さにする
      phraseFirstRestDuration = quarterNoteDuration;
    } else {
      phraseFirstRestDuration = phraseFirstNote.position;
    }
  } else {
    const prevPhraseLastNoteEndPos =
      prevPhraseLastNote.position + prevPhraseLastNote.duration;
    phraseFirstRestDuration =
      phraseFirstNote.position - prevPhraseLastNoteEndPos;
  }
  // 4分音符の長さ以下にする
  phraseFirstRestDuration = Math.min(
    phraseFirstRestDuration,
    quarterNoteDuration,
  );
  // 最小の長さ以上にする
  phraseFirstRestDuration = Math.max(
    phraseFirstRestDuration,
    phraseFirstNote.position -
      secondToTick(
        tickToSecond(phraseFirstNote.position, tempos, tpqn) -
          phraseFirstRestMinDurationSeconds,
        tempos,
        tpqn,
      ),
  );
  // 1tick以上にする
  phraseFirstRestDuration = Math.max(1, phraseFirstRestDuration);

  return phraseFirstRestDuration;
};

const calculatePhraseStartTime = (
  phraseFirstRestDuration: number,
  phraseNotes: Note[],
  tempos: Tempo[],
  tpqn: number,
) => {
  return tickToSecond(
    phraseNotes[0].position - phraseFirstRestDuration,
    tempos,
    tpqn,
  );
};

/**
 * トラックのノーツからフレーズごとのノーツを抽出する。
 */
const extractPhraseNotes = (trackNotes: Note[]) => {
  const phraseNotes: Note[][] = [];
  let currentPhraseNotes: Note[] = [];

  for (let i = 0; i < trackNotes.length; i++) {
    const note = trackNotes[i];
    const nextNote = trackNotes.at(i + 1);
    const currentNoteEndPos = note.position + note.duration;

    currentPhraseNotes.push(note);

    // ノートが途切れていたら別のフレーズにする
    if (nextNote == undefined || currentNoteEndPos !== nextNote.position) {
      phraseNotes.push([...currentPhraseNotes]);
      currentPhraseNotes = [];
    }
  }

  return phraseNotes;
};

/**
 * フレーズごとのノーツからフレーズを生成する。
 */
const createPhrasesFromNotes = async (
  phraseNotesList: Note[][],
  trackId: TrackId,
  snapshot: SnapshotForRender,
  firstRestMinDurationSeconds: number,
) => {
  const track = getOrThrow(snapshot.tracks, trackId);
  const phrases = new Map<PhraseKey, PhraseForRender>();

  for (let i = 0; i < phraseNotesList.length; i++) {
    const phraseNotes = phraseNotesList[i];
    const phraseFirstNote = phraseNotes[0];
    const phraseLastNote = getLast(phraseNotes);
    const prevPhraseNotes = getPrev(phraseNotesList, i);
    const prevPhraseLastNote = prevPhraseNotes?.at(-1);

    const phraseFirstRestDuration = calcPhraseFirstRestDuration(
      prevPhraseLastNote,
      phraseFirstNote,
      firstRestMinDurationSeconds,
      snapshot.tempos,
      snapshot.tpqn,
    );
    const phraseStartTime = calculatePhraseStartTime(
      phraseFirstRestDuration,
      phraseNotes,
      snapshot.tempos,
      snapshot.tpqn,
    );
    const phraseKey = await calculatePhraseKey({
      firstRestDuration: phraseFirstRestDuration,
      notes: phraseNotes,
      startTime: phraseStartTime,
      trackId,
    });
    phrases.set(phraseKey, {
      singer: track.singer,
      firstRestDuration: phraseFirstRestDuration,
      notes: phraseNotes,
      startTicks: phraseFirstNote.position,
      endTicks: phraseLastNote.position + phraseLastNote.duration,
      startTime: phraseStartTime,
      trackId,
      errorOccurredDuringRendering: false,
    });
  }

  return phrases;
};

/**
 * 各トラックのノーツからフレーズを生成してセットする。
 * 重なっているノートはフレーズには含まれない。
 */
const generateAndSetPhrases = async (
  context: SongTrackRenderingContext,
  config: SongTrackRenderingConfig,
) => {
  for (const [trackId, track] of context.snapshot.tracks) {
    // 重なっているノートを除く
    const overlappingNoteIds = getOrThrow(
      context.snapshot.trackOverlappingNoteIds,
      trackId,
    );
    const trackNotes = track.notes.filter(
      (value) => !overlappingNoteIds.has(value.id),
    );

    // トラックのノーツからフレーズごとのノーツを抽出
    const phraseNotesList = extractPhraseNotes(trackNotes);

    // フレーズごとのノーツからフレーズを生成
    const trackPhrases = await createPhrasesFromNotes(
      phraseNotesList,
      trackId,
      context.snapshot,
      config.firstRestMinDurationSeconds,
    );

    // 結果をマージ
    for (const [key, phrase] of trackPhrases) {
      context.phrases.set(key, phrase);
    }
  }
};

const generateQuerySource = (
  phrase: PhraseForRender,
  snapshot: SnapshotForRender,
): QuerySource => {
  const track = getOrThrow(snapshot.tracks, phrase.trackId);
  if (track.singer == undefined) {
    throw new Error("track.singer is undefined.");
  }
  const engineFrameRate = getOrThrow(
    snapshot.engineFrameRates,
    track.singer.engineId,
  );
  return {
    engineId: track.singer.engineId,
    engineFrameRate,
    tpqn: snapshot.tpqn,
    tempos: snapshot.tempos,
    firstRestDuration: phrase.firstRestDuration,
    notes: phrase.notes,
    keyRangeAdjustment: track.keyRangeAdjustment,
  };
};

const generateSingingPitchSource = (
  phrase: PhraseForRender,
  snapshot: SnapshotForRender,
): SingingPitchSource => {
  const track = getOrThrow(snapshot.tracks, phrase.trackId);
  if (track.singer == undefined) {
    throw new Error("track.singer is undefined.");
  }
  if (phrase.phonemeTimingEditingAppliedQuery == undefined) {
    throw new Error("phrase.phonemeTimingEditingAppliedQuery is undefined.");
  }

  const clonedQuery = structuredClone(phrase.phonemeTimingEditingAppliedQuery);

  return {
    engineId: track.singer.engineId,
    engineFrameRate: clonedQuery.frameRate,
    tpqn: snapshot.tpqn,
    tempos: snapshot.tempos,
    firstRestDuration: phrase.firstRestDuration,
    notes: phrase.notes,
    keyRangeAdjustment: track.keyRangeAdjustment,
    queryForPitchGeneration: clonedQuery,
  };
};

const generateSingingVolumeSource = (
  phrase: PhraseForRender,
  snapshot: SnapshotForRender,
): SingingVolumeSource => {
  const track = getOrThrow(snapshot.tracks, phrase.trackId);
  if (track.singer == undefined) {
    throw new Error("track.singer is undefined.");
  }
  if (phrase.query == undefined) {
    throw new Error("phrase.query is undefined.");
  }
  if (phrase.singingPitch == undefined) {
    throw new Error("phrase.singingPitch is undefined.");
  }

  const clonedQuery = structuredClone(phrase.query);
  const clonedSingingPitch = structuredClone(phrase.singingPitch);

  clonedQuery.f0 = clonedSingingPitch;

  applyPitchEdit(
    clonedQuery,
    phrase.startTime,
    track.pitchEditData,
    snapshot.editorFrameRate,
  );

  return {
    engineId: track.singer.engineId,
    engineFrameRate: phrase.query.frameRate,
    tpqn: snapshot.tpqn,
    tempos: snapshot.tempos,
    firstRestDuration: phrase.firstRestDuration,
    notes: phrase.notes,
    keyRangeAdjustment: track.keyRangeAdjustment,
    volumeRangeAdjustment: track.volumeRangeAdjustment,
    queryForVolumeGeneration: clonedQuery,
  };
};

const generateSingingVoiceSource = (
  phrase: PhraseForRender,
  snapshot: SnapshotForRender,
): SingingVoiceSource => {
  const track = getOrThrow(snapshot.tracks, phrase.trackId);
  if (track.singer == undefined) {
    throw new Error("track.singer is undefined.");
  }
  if (phrase.query == undefined) {
    throw new Error("phrase.query is undefined.");
  }
  if (phrase.singingPitch == undefined) {
    throw new Error("phrase.singingPitch is undefined.");
  }
  if (phrase.singingVolume == undefined) {
    throw new Error("phrase.singingVolume is undefined.");
  }

  const clonedQuery = structuredClone(phrase.query);
  const clonedSingingPitch = structuredClone(phrase.singingPitch);
  const clonedSingingVolume = structuredClone(phrase.singingVolume);

  clonedQuery.f0 = clonedSingingPitch;
  clonedQuery.volume = clonedSingingVolume;

  applyPitchEdit(
    clonedQuery,
    phrase.startTime,
    track.pitchEditData,
    snapshot.editorFrameRate,
  );

  return {
    singer: track.singer,
    queryForSingingVoiceSynthesis: clonedQuery,
  };
};

const generateQuery = async (
  querySource: QuerySource,
  config: SongTrackRenderingConfig,
  engineSongApi: EngineSongApi,
) => {
  const notesForRequestToEngine = createNotesForRequestToEngine(
    querySource.firstRestDuration,
    config.lastRestDurationSeconds,
    querySource.notes,
    querySource.tempos,
    querySource.tpqn,
    querySource.engineFrameRate,
  );

  shiftKeyOfNotes(notesForRequestToEngine, -querySource.keyRangeAdjustment);

  const query = await engineSongApi.fetchFrameAudioQuery({
    engineId: querySource.engineId,
    styleId: config.singingTeacherStyleId,
    engineFrameRate: querySource.engineFrameRate,
    notes: notesForRequestToEngine,
  });

  shiftPitch(query.f0, querySource.keyRangeAdjustment);

  return query;
};

const generateSingingPitch = async (
  singingPitchSource: SingingPitchSource,
  config: SongTrackRenderingConfig,
  engineSongApi: EngineSongApi,
) => {
  const notesForRequestToEngine = createNotesForRequestToEngine(
    singingPitchSource.firstRestDuration,
    config.lastRestDurationSeconds,
    singingPitchSource.notes,
    singingPitchSource.tempos,
    singingPitchSource.tpqn,
    singingPitchSource.engineFrameRate,
  );
  const queryForPitchGeneration = singingPitchSource.queryForPitchGeneration;

  shiftKeyOfNotes(
    notesForRequestToEngine,
    -singingPitchSource.keyRangeAdjustment,
  );

  const singingPitch = await engineSongApi.fetchSingFrameF0({
    notes: notesForRequestToEngine,
    query: queryForPitchGeneration,
    engineId: singingPitchSource.engineId,
    styleId: config.singingTeacherStyleId,
  });

  shiftPitch(singingPitch, singingPitchSource.keyRangeAdjustment);

  return singingPitch;
};

const generateSingingVolume = async (
  singingVolumeSource: SingingVolumeSource,
  config: SongTrackRenderingConfig,
  engineSongApi: EngineSongApi,
) => {
  const notesForRequestToEngine = createNotesForRequestToEngine(
    singingVolumeSource.firstRestDuration,
    config.lastRestDurationSeconds,
    singingVolumeSource.notes,
    singingVolumeSource.tempos,
    singingVolumeSource.tpqn,
    singingVolumeSource.engineFrameRate,
  );
  const queryForVolumeGeneration = singingVolumeSource.queryForVolumeGeneration;

  shiftKeyOfNotes(
    notesForRequestToEngine,
    -singingVolumeSource.keyRangeAdjustment,
  );
  shiftPitch(
    queryForVolumeGeneration.f0,
    -singingVolumeSource.keyRangeAdjustment,
  );

  const singingVolume = await engineSongApi.fetchSingFrameVolume({
    notes: notesForRequestToEngine,
    query: queryForVolumeGeneration,
    engineId: singingVolumeSource.engineId,
    styleId: config.singingTeacherStyleId,
  });

  shiftVolume(singingVolume, singingVolumeSource.volumeRangeAdjustment);
  muteLastPauSection(
    singingVolume,
    queryForVolumeGeneration.phonemes,
    singingVolumeSource.engineFrameRate,
    config.fadeOutDurationSeconds,
  );

  return singingVolume;
};

const synthesizeSingingVoice = async (
  singingVoiceSource: SingingVoiceSource,
  engineSongApi: EngineSongApi,
) => {
  const singingVoice = await engineSongApi.frameSynthesis({
    query: singingVoiceSource.queryForSingingVoiceSynthesis,
    engineId: singingVoiceSource.singer.engineId,
    styleId: singingVoiceSource.singer.styleId,
  });

  return singingVoice;
};

class FrameAudioQueryGenerationTask
  implements CacheableTask<SongTrackRenderingContext>
{
  readonly type = "frameAudioQueryGeneration";
  readonly skipCondition: SkipCondition = "AnyDependencyFailedOrSkipped";
  readonly isCacheable = true;

  readonly dependencies: Task<SongTrackRenderingContext>[];
  readonly targetPhraseKey: PhraseKey;

  private readonly config: SongTrackRenderingConfig;
  private readonly engineSongApi: EngineSongApi;
  private readonly queryCache: Map<
    EditorFrameAudioQueryKey,
    EditorFrameAudioQuery
  >;

  constructor(
    dependencies: Task<SongTrackRenderingContext>[],
    targetPhraseKey: PhraseKey,
    config: SongTrackRenderingConfig,
    engineSongApi: EngineSongApi,
    queryCache: Map<EditorFrameAudioQueryKey, EditorFrameAudioQuery>,
  ) {
    this.dependencies = dependencies;
    this.targetPhraseKey = targetPhraseKey;
    this.config = config;
    this.engineSongApi = engineSongApi;
    this.queryCache = queryCache;
  }

  async isCached(context: SongTrackRenderingContext) {
    const targetPhrase = getOrThrow(context.phrases, this.targetPhraseKey);
    const querySource = generateQuerySource(targetPhrase, context.snapshot);
    const queryKey = await calculateQueryKey(querySource);
    return this.queryCache.has(queryKey);
  }

  async run(context: SongTrackRenderingContext) {
    const targetPhrase = getOrThrow(context.phrases, this.targetPhraseKey);
    const querySource = generateQuerySource(targetPhrase, context.snapshot);
    const queryKey = await calculateQueryKey(querySource);

    let query = this.queryCache.get(queryKey);
    if (query == undefined) {
      query = await generateQuery(querySource, this.config, this.engineSongApi);
      this.queryCache.set(queryKey, query);
    }
    targetPhrase.queryKey = queryKey;
    targetPhrase.query = query;
  }
}

class EditingAndAdjustingPhonemeTimingTask
  implements NonCacheableTask<SongTrackRenderingContext>
{
  readonly type = "editingAndAdjustingPhonemeTiming";
  readonly skipCondition: SkipCondition = "AllDependenciesFailedOrSkipped";
  readonly isCacheable = false;

  readonly dependencies: Task<SongTrackRenderingContext>[];
  readonly targetTrackId: TrackId;

  constructor(
    dependencies: Task<SongTrackRenderingContext>[],
    targetTrackId: TrackId,
  ) {
    this.dependencies = dependencies;
    this.targetTrackId = targetTrackId;
  }

  async run(context: SongTrackRenderingContext) {
    const targetTrack = getOrThrow(context.snapshot.tracks, this.targetTrackId);
    const targetPhraseEntries = [...context.phrases.entries()].filter(
      (entry) => {
        const phrase = entry[1];
        return (
          phrase.trackId === this.targetTrackId && phrase.query != undefined
        );
      },
    );
    const targetPhraseKeyArray = targetPhraseEntries.map((entry) => entry[0]);
    const targetPhraseArray = targetPhraseEntries.map((entry) => entry[1]);
    const targetPhraseStartTimes = targetPhraseArray.map(
      (phrase) => phrase.startTime,
    );
    const loadedQueryArray = targetPhraseArray
      .map((phrase) => phrase.query)
      .filter((query) => query != undefined);

    const clonedQueryArray = structuredClone(loadedQueryArray);

    // TODO: この関数のインターフェースがいまいちなので、リファクタリングする
    applyPhonemeTimingEditAndAdjust(
      targetPhraseStartTimes,
      clonedQueryArray,
      targetTrack.phonemeTimingEditData,
      context.snapshot.editorFrameRate,
    );

    const queryEntries = clonedQueryArray.map(
      (value, index) => [targetPhraseKeyArray[index], value] as const,
    );
    const queryMap = new Map(queryEntries);

    for (const [phraseKey, phrase] of targetPhraseEntries) {
      phrase.phonemeTimingEditingAppliedQuery = getOrThrow(queryMap, phraseKey);
    }
  }
}

class SingingPitchGenerationTask
  implements CacheableTask<SongTrackRenderingContext>
{
  readonly type = "singingPitchGeneration";
  readonly skipCondition: SkipCondition = "AnyDependencyFailedOrSkipped";
  readonly isCacheable = true;

  readonly dependencies: Task<SongTrackRenderingContext>[];
  readonly targetPhraseKey: PhraseKey;

  private readonly config: SongTrackRenderingConfig;
  private readonly engineSongApi: EngineSongApi;
  private readonly singingPitchCache: Map<SingingPitchKey, SingingPitch>;

  constructor(
    dependencies: Task<SongTrackRenderingContext>[],
    targetPhraseKey: PhraseKey,
    config: SongTrackRenderingConfig,
    engineSongApi: EngineSongApi,
    queryCache: Map<SingingPitchKey, SingingPitch>,
  ) {
    this.dependencies = dependencies;
    this.targetPhraseKey = targetPhraseKey;
    this.config = config;
    this.engineSongApi = engineSongApi;
    this.singingPitchCache = queryCache;
  }

  async isCached(context: SongTrackRenderingContext) {
    const targetPhrase = getOrThrow(context.phrases, this.targetPhraseKey);
    const singingPitchSource = generateSingingPitchSource(
      targetPhrase,
      context.snapshot,
    );
    const singingPitchKey = await calculateSingingPitchKey(singingPitchSource);
    return this.singingPitchCache.has(singingPitchKey);
  }

  async run(context: SongTrackRenderingContext) {
    const targetPhrase = getOrThrow(context.phrases, this.targetPhraseKey);
    const singingPitchSource = generateSingingPitchSource(
      targetPhrase,
      context.snapshot,
    );
    const singingPitchKey = await calculateSingingPitchKey(singingPitchSource);

    let singingPitch = this.singingPitchCache.get(singingPitchKey);
    if (singingPitch == undefined) {
      singingPitch = await generateSingingPitch(
        singingPitchSource,
        this.config,
        this.engineSongApi,
      );
      this.singingPitchCache.set(singingPitchKey, singingPitch);
    }
    targetPhrase.singingPitchKey = singingPitchKey;
    targetPhrase.singingPitch = singingPitch;
  }
}

class SingingVolumeGenerationTask
  implements CacheableTask<SongTrackRenderingContext>
{
  readonly type = "singingVolumeGeneration";
  readonly skipCondition: SkipCondition = "AnyDependencyFailedOrSkipped";
  readonly isCacheable = true;

  readonly dependencies: Task<SongTrackRenderingContext>[];
  readonly targetPhraseKey: PhraseKey;

  private readonly config: SongTrackRenderingConfig;
  private readonly engineSongApi: EngineSongApi;
  private readonly singingVolumeCache: Map<SingingVolumeKey, SingingVolume>;

  constructor(
    dependencies: Task<SongTrackRenderingContext>[],
    targetPhraseKey: PhraseKey,
    config: SongTrackRenderingConfig,
    engineSongApi: EngineSongApi,
    queryCache: Map<SingingVolumeKey, SingingVolume>,
  ) {
    this.dependencies = dependencies;
    this.targetPhraseKey = targetPhraseKey;
    this.config = config;
    this.engineSongApi = engineSongApi;
    this.singingVolumeCache = queryCache;
  }

  async isCached(context: SongTrackRenderingContext) {
    const targetPhrase = getOrThrow(context.phrases, this.targetPhraseKey);
    const singingVolumeSource = generateSingingVolumeSource(
      targetPhrase,
      context.snapshot,
    );
    const singingVolumeKey =
      await calculateSingingVolumeKey(singingVolumeSource);
    return this.singingVolumeCache.has(singingVolumeKey);
  }

  async run(context: SongTrackRenderingContext) {
    const targetPhrase = getOrThrow(context.phrases, this.targetPhraseKey);
    const singingVolumeSource = generateSingingVolumeSource(
      targetPhrase,
      context.snapshot,
    );
    const singingVolumeKey =
      await calculateSingingVolumeKey(singingVolumeSource);

    let singingVolume = this.singingVolumeCache.get(singingVolumeKey);
    if (singingVolume == undefined) {
      singingVolume = await generateSingingVolume(
        singingVolumeSource,
        this.config,
        this.engineSongApi,
      );
      this.singingVolumeCache.set(singingVolumeKey, singingVolume);
    }
    targetPhrase.singingVolumeKey = singingVolumeKey;
    targetPhrase.singingVolume = singingVolume;
  }
}

class SingingVoiceSynthesisTask
  implements CacheableTask<SongTrackRenderingContext>
{
  readonly type = "singingVoiceSynthesis";
  readonly skipCondition: SkipCondition = "AnyDependencyFailedOrSkipped";
  readonly isCacheable = true;

  readonly dependencies: Task<SongTrackRenderingContext>[];
  readonly targetPhraseKey: PhraseKey;

  private readonly engineSongApi: EngineSongApi;
  private readonly singingVoiceCache: Map<SingingVoiceKey, SingingVoice>;

  constructor(
    dependencies: Task<SongTrackRenderingContext>[],
    targetPhraseKey: PhraseKey,
    engineSongApi: EngineSongApi,
    queryCache: Map<SingingVoiceKey, SingingVoice>,
  ) {
    this.dependencies = dependencies;
    this.targetPhraseKey = targetPhraseKey;
    this.engineSongApi = engineSongApi;
    this.singingVoiceCache = queryCache;
  }

  async isCached(context: SongTrackRenderingContext) {
    const targetPhrase = getOrThrow(context.phrases, this.targetPhraseKey);
    const singingVoiceSource = generateSingingVoiceSource(
      targetPhrase,
      context.snapshot,
    );
    const singingVoiceKey = await calculateSingingVoiceKey(singingVoiceSource);
    return this.singingVoiceCache.has(singingVoiceKey);
  }

  async run(context: SongTrackRenderingContext) {
    const targetPhrase = getOrThrow(context.phrases, this.targetPhraseKey);
    const singingVoiceSource = generateSingingVoiceSource(
      targetPhrase,
      context.snapshot,
    );
    const singingVoiceKey = await calculateSingingVoiceKey(singingVoiceSource);

    let singingVoice = this.singingVoiceCache.get(singingVoiceKey);
    if (singingVoice == undefined) {
      singingVoice = await synthesizeSingingVoice(
        singingVoiceSource,
        this.engineSongApi,
      );
      this.singingVoiceCache.set(singingVoiceKey, singingVoice);
    }
    targetPhrase.singingVoiceKey = singingVoiceKey;
    targetPhrase.singingVoice = singingVoice;
  }
}

type SongTrackRenderingTask =
  | FrameAudioQueryGenerationTask
  | EditingAndAdjustingPhonemeTimingTask
  | SingingPitchGenerationTask
  | SingingVolumeGenerationTask
  | SingingVoiceSynthesisTask;

/**
 * クエリの生成結果。
 */
type QueryGenerationResult =
  | {
      readonly type: "success";
      readonly queryKey: EditorFrameAudioQueryKey;
      readonly query: EditorFrameAudioQuery;
    }
  | {
      readonly type: "error";
      readonly error: unknown;
    };

/**
 * 歌唱ピッチの生成結果。
 */
type PitchGenerationResult =
  | {
      readonly type: "success";
      readonly singingPitchKey: SingingPitchKey;
      readonly singingPitch: SingingPitch;
    }
  | {
      readonly type: "error";
      readonly error: unknown;
    };

/**
 * 歌唱ボリュームの生成結果。
 */
type VolumeGenerationResult =
  | {
      readonly type: "success";
      readonly singingVolumeKey: SingingVolumeKey;
      readonly singingVolume: SingingVolume;
    }
  | {
      readonly type: "error";
      readonly error: unknown;
    };

/**
 * 歌声の合成結果。
 */
type VoiceSynthesisResult =
  | {
      readonly type: "success";
      readonly singingVoiceKey: SingingVoiceKey;
      readonly singingVoice: SingingVoice;
    }
  | {
      readonly type: "error";
      readonly error: unknown;
    };

/**
 * ソングトラックのレンダリング結果。
 */
export type SongTrackRenderingResult =
  | {
      readonly type: "complete";
      readonly phrases: Map<PhraseKey, PhraseForRender>;
    }
  | {
      readonly type: "interrupted";
    };

/**
 * レンダリングを開始したときに発行されるイベント。
 */
export type RenderingStartedEvent = {
  readonly type: "renderingStarted";
  readonly context: ReadonlySongTrackRenderingContext;
};

/**
 * キャッシュの読み込み処理が終了したときに発行されるイベント。
 * （クエリの生成が行われる前のキャッシュ読み込み処理）
 */
export type CacheLoadFinishedEvent = {
  readonly type: "cacheLoadFinished";
  readonly cacheLoadedPhraseKeys: ReadonlySet<PhraseKey>;
  readonly context: ReadonlySongTrackRenderingContext;
};

/**
 * トラックのクエリの生成が開始されたときに発行されるイベント。
 */
export type TrackQueryGenerationStartedEvent = {
  readonly type: "trackQueryGenerationStarted";
  readonly trackId: TrackId;
  readonly context: ReadonlySongTrackRenderingContext;
};

/**
 * トラックのクエリの生成が終了したときに発行されるイベント。
 */
export type TrackQueryGenerationFinishedEvent = {
  readonly type: "trackQueryGenerationFinished";
  readonly trackId: TrackId;
  readonly results: Map<PhraseKey, QueryGenerationResult>;
  readonly context: ReadonlySongTrackRenderingContext;
};

/**
 * 歌唱ピッチの生成が開始されたときに発行されるイベント。
 */
export type PitchGenerationStartedEvent = {
  readonly type: "pitchGenerationStarted";
  readonly phraseKey: PhraseKey;
  readonly context: ReadonlySongTrackRenderingContext;
};

/**
 * 歌唱ピッチの生成が終了したときに発行されるイベント。
 */
export type PitchGenerationFinishedEvent = {
  readonly type: "pitchGenerationFinished";
  readonly phraseKey: PhraseKey;
  readonly result: PitchGenerationResult;
  readonly context: ReadonlySongTrackRenderingContext;
};

/**
 * 歌唱ボリュームの生成が開始されたときに発行されるイベント。
 */
export type VolumeGenerationStartedEvent = {
  readonly type: "volumeGenerationStarted";
  readonly phraseKey: PhraseKey;
  readonly context: ReadonlySongTrackRenderingContext;
};

/**
 * 歌唱ボリュームの生成が終了したときに発行されるイベント。
 */
export type VolumeGenerationFinishedEvent = {
  readonly type: "volumeGenerationFinished";
  readonly phraseKey: PhraseKey;
  readonly result: VolumeGenerationResult;
  readonly context: ReadonlySongTrackRenderingContext;
};

/**
 * 歌声の合成が開始されたときに発行されるイベント。
 */
export type VoiceSynthesisStartedEvent = {
  readonly type: "voiceSynthesisStarted";
  readonly phraseKey: PhraseKey;
  readonly context: ReadonlySongTrackRenderingContext;
};

/**
 * 歌声の合成が終了したときに発行されるイベント。
 */
export type VoiceSynthesisFinishedEvent = {
  readonly type: "voiceSynthesisFinished";
  readonly phraseKey: PhraseKey;
  readonly result: VoiceSynthesisResult;
  readonly context: ReadonlySongTrackRenderingContext;
};

/**
 * レンダリングが終了したときに発行されるイベント。
 */
export type RenderingCompletedEvent = {
  readonly type: "renderingCompleted";
  readonly context: ReadonlySongTrackRenderingContext;
};

export type SongTrackRenderingEvent =
  | RenderingStartedEvent
  | CacheLoadFinishedEvent
  | TrackQueryGenerationStartedEvent
  | TrackQueryGenerationFinishedEvent
  | PitchGenerationStartedEvent
  | PitchGenerationFinishedEvent
  | VolumeGenerationStartedEvent
  | VolumeGenerationFinishedEvent
  | VoiceSynthesisStartedEvent
  | VoiceSynthesisFinishedEvent
  | RenderingCompletedEvent;

/**
 * ソングトラックのレンダリング処理を担当するクラス。
 * フレーズ生成、キャッシュ管理、エンジンAPIとの連携、イベント通知などを行う。
 */
export class SongTrackRenderer {
  private readonly config: SongTrackRenderingConfig;
  private readonly engineSongApi: EngineSongApi;
  private readonly playheadPositionGetter: () => number;

  private readonly queryCache: Map<
    EditorFrameAudioQueryKey,
    EditorFrameAudioQuery
  > = new Map();
  private readonly singingPitchCache: Map<SingingPitchKey, SingingPitch> =
    new Map();
  private readonly singingVolumeCache: Map<SingingVolumeKey, SingingVolume> =
    new Map();
  private readonly singingVoiceCache: Map<SingingVoiceKey, SingingVoice> =
    new Map();

  private readonly listeners: Set<(event: SongTrackRenderingEvent) => void> =
    new Set();

  private _isRendering = false;
  private interruptionRequested = false;

  /**
   * 現在レンダリング処理を実行中かどうかを取得する。
   *
   * @returns レンダリング中の場合は `true`、そうでない場合は `false`。
   */
  get isRendering() {
    return this._isRendering;
  }

  /**
   * SongTrackRenderer の新しいインスタンスを生成する。
   *
   * @param args コンストラクタ引数。
   * @param args.config レンダリングに関する設定。
   * @param args.engineSongApi エンジンAPIへのインターフェース。
   * @param args.playheadPositionGetter 再生ヘッド位置のゲッター。
   */
  constructor(args: {
    config: SongTrackRenderingConfig;
    engineSongApi: EngineSongApi;
    playheadPositionGetter: () => number;
  }) {
    this.config = args.config;
    this.engineSongApi = args.engineSongApi;
    this.playheadPositionGetter = args.playheadPositionGetter;
  }

  /**
   * 指定されたスナップショットに基づいてソングトラックのレンダリングを実行する。
   *
   * @param snapshot レンダリングの元となるプロジェクトの状態のスナップショット。
   * @returns レンダリング結果。完了した場合はフレーズ情報、中断された場合は中断を示す情報。
   * @throws 既に別のレンダリング処理が進行中の場合にエラーをスローする。
   */
  async render(snapshot: SnapshotForRender): Promise<SongTrackRenderingResult> {
    if (this._isRendering) {
      throw new Error("Rendering is already in progress.");
    }
    this._isRendering = true;

    const context: SongTrackRenderingContext = {
      snapshot,
      phrases: new Map(),
    };

    this.dispatchEvent({ type: "renderingStarted", context });

    try {
      await generateAndSetPhrases(context, this.config);

      const taskGraphRunner = this.createAndSetupTaskGraphRunner(context);

      await taskGraphRunner.run();

      // 中断要求があった場合は interrupted、中断要求がなかった場合は complete を返す
      if (this.interruptionRequested) {
        return { type: "interrupted" };
      } else {
        this.dispatchEvent({
          type: "renderingCompleted",
          context,
        });

        return { type: "complete", phrases: context.phrases };
      }
    } finally {
      this.interruptionRequested = false;
      this._isRendering = false;
    }
  }

  private createAndSetupTaskGraphRunner(context: SongTrackRenderingContext) {
    let cacheLoadPhase = false;
    let cacheLoadedPhraseKeys = new Set<PhraseKey>();

    let trackIdDuringQueryGeneration: TrackId | undefined = undefined;
    let remainingQueryGenerationTaskCount = 0;
    let queryGenerationResults = new Map<PhraseKey, QueryGenerationResult>();

    const selector = async () => {
      return undefined;
    };

    const taskGraph = this.buildTaskGraph(context);
    const taskGraphRunner = new TaskGraphRunner(
      context,
      taskGraph,
      selector,
      true,
    );

    const onCacheLoadFinished = () => {
      this.dispatchEvent({
        type: "cacheLoadFinished",
        cacheLoadedPhraseKeys,
        context,
      });

      cacheLoadedPhraseKeys = new Set();
    };

    const onQueryGenerationTaskStarted = (
      task: FrameAudioQueryGenerationTask,
    ) => {
      if (trackIdDuringQueryGeneration != undefined) {
        return;
      }
      const targetPhraseKey = task.targetPhraseKey;
      const targetTrackId = getOrThrow(
        context.phrases,
        targetPhraseKey,
      ).trackId;

      trackIdDuringQueryGeneration = targetTrackId;
      remainingQueryGenerationTaskCount = 0;

      for (const [task, taskStatus] of taskGraphRunner.taskStatuses) {
        if (task.type !== "frameAudioQueryGeneration") {
          continue;
        }
        if (
          taskStatus.runStatus === "AwaitingDependencies" ||
          taskStatus.runStatus === "Runnable" ||
          taskStatus.runStatus === "Running"
        ) {
          const phrase = getOrThrow(context.phrases, task.targetPhraseKey);
          if (phrase.trackId === targetTrackId) {
            remainingQueryGenerationTaskCount++;
          }
        }
      }
      this.dispatchEvent({
        type: "trackQueryGenerationStarted",
        trackId: targetTrackId,
        context,
      });
    };

    const onPitchGenerationTaskStarted = (task: SingingPitchGenerationTask) => {
      this.dispatchEvent({
        type: "pitchGenerationStarted",
        phraseKey: task.targetPhraseKey,
        context,
      });
    };

    const onVolumeGenerationTaskStarted = (
      task: SingingVolumeGenerationTask,
    ) => {
      this.dispatchEvent({
        type: "volumeGenerationStarted",
        phraseKey: task.targetPhraseKey,
        context,
      });
    };

    const onVoiceSynthesisTaskStarted = (task: SingingVoiceSynthesisTask) => {
      this.dispatchEvent({
        type: "voiceSynthesisStarted",
        phraseKey: task.targetPhraseKey,
        context,
      });
    };

    const onQueryGenerationTaskFinished = (
      task: FrameAudioQueryGenerationTask,
      taskResult: TaskResultInfo,
    ) => {
      if (trackIdDuringQueryGeneration == undefined) {
        throw new UnreachableError("Track ID is undefined.");
      }
      const targetPhraseKey = task.targetPhraseKey;

      switch (taskResult.type) {
        case "Success": {
          const phrase = getOrThrow(context.phrases, targetPhraseKey);
          if (phrase.queryKey == undefined || phrase.query == undefined) {
            throw new UnreachableError("Query or key is undefined.");
          }
          queryGenerationResults.set(targetPhraseKey, {
            type: "success",
            queryKey: phrase.queryKey,
            query: phrase.query,
          });
          break;
        }
        case "Failed":
          queryGenerationResults.set(targetPhraseKey, {
            type: "error",
            error: taskResult.error,
          });
          break;
        default:
          throw new ExhaustiveError(taskResult);
      }

      remainingQueryGenerationTaskCount--;

      if (remainingQueryGenerationTaskCount === 0) {
        this.dispatchEvent({
          type: "trackQueryGenerationFinished",
          trackId: trackIdDuringQueryGeneration,
          results: queryGenerationResults,
          context,
        });

        trackIdDuringQueryGeneration = undefined;
        queryGenerationResults = new Map();
      }
    };

    const onPitchGenerationTaskFinished = (
      task: SingingPitchGenerationTask,
      taskResult: TaskResultInfo,
    ) => {
      const targetPhraseKey = task.targetPhraseKey;

      let result: PitchGenerationResult;
      switch (taskResult.type) {
        case "Success": {
          const phrase = getOrThrow(context.phrases, targetPhraseKey);
          if (
            phrase.singingPitchKey == undefined ||
            phrase.singingPitch == undefined
          ) {
            throw new UnreachableError("Singing pitch or key is undefined.");
          }
          result = {
            type: "success",
            singingPitchKey: phrase.singingPitchKey,
            singingPitch: phrase.singingPitch,
          };
          break;
        }
        case "Failed":
          result = {
            type: "error",
            error: taskResult.error,
          };
          break;
        default:
          throw new ExhaustiveError(taskResult);
      }

      this.dispatchEvent({
        type: "pitchGenerationFinished",
        phraseKey: task.targetPhraseKey,
        result,
        context,
      });
    };

    const onVolumeGenerationTaskFinished = (
      task: SingingVolumeGenerationTask,
      taskResult: TaskResultInfo,
    ) => {
      const targetPhraseKey = task.targetPhraseKey;

      let result: VolumeGenerationResult;
      switch (taskResult.type) {
        case "Success": {
          const phrase = getOrThrow(context.phrases, targetPhraseKey);
          if (
            phrase.singingVolumeKey == undefined ||
            phrase.singingVolume == undefined
          ) {
            throw new UnreachableError("Singing volume or key is undefined.");
          }
          result = {
            type: "success",
            singingVolumeKey: phrase.singingVolumeKey,
            singingVolume: phrase.singingVolume,
          };
          break;
        }
        case "Failed":
          result = {
            type: "error",
            error: taskResult.error,
          };
          break;
        default:
          throw new ExhaustiveError(taskResult);
      }

      this.dispatchEvent({
        type: "volumeGenerationFinished",
        phraseKey: task.targetPhraseKey,
        result,
        context,
      });
    };

    const onVoiceSynthesisTaskFinished = (
      task: SingingVoiceSynthesisTask,
      taskResult: TaskResultInfo,
    ) => {
      const targetPhraseKey = task.targetPhraseKey;

      let result: VoiceSynthesisResult;
      switch (taskResult.type) {
        case "Success": {
          const phrase = getOrThrow(context.phrases, targetPhraseKey);
          if (
            phrase.singingVoiceKey == undefined ||
            phrase.singingVoice == undefined
          ) {
            throw new UnreachableError("Singing voice or key is undefined.");
          }
          result = {
            type: "success",
            singingVoiceKey: phrase.singingVoiceKey,
            singingVoice: phrase.singingVoice,
          };
          break;
        }
        case "Failed":
          result = {
            type: "error",
            error: taskResult.error,
          };
          break;
        default:
          throw new ExhaustiveError(taskResult);
      }

      this.dispatchEvent({
        type: "voiceSynthesisFinished",
        phraseKey: task.targetPhraseKey,
        result,
        context,
      });
    };

    taskGraphRunner.addEventListener((event) => {
      if (cacheLoadPhase) {
        if (
          (event.type === "taskStarted" && !event.isCachedTask) ||
          event.type === "completed"
        ) {
          onCacheLoadFinished();
          cacheLoadPhase = false;
        }
      } else {
        if (event.type === "taskStarted" && event.isCachedTask) {
          if (!event.task.isCacheable) {
            throw new UnreachableError();
          }
          cacheLoadPhase = true;
          cacheLoadedPhraseKeys.add(event.task.targetPhraseKey);
        }
      }

      switch (event.type) {
        case "taskStarted":
          if (!event.isCachedTask) {
            switch (event.task.type) {
              case "frameAudioQueryGeneration":
                onQueryGenerationTaskStarted(event.task);
                break;
              case "singingPitchGeneration":
                onPitchGenerationTaskStarted(event.task);
                break;
              case "singingVolumeGeneration":
                onVolumeGenerationTaskStarted(event.task);
                break;
              case "singingVoiceSynthesis":
                onVoiceSynthesisTaskStarted(event.task);
                break;
            }
          }
          break;
        case "taskFinished":
          switch (event.task.type) {
            case "frameAudioQueryGeneration":
              onQueryGenerationTaskFinished(event.task, event.result);
              break;
            case "singingPitchGeneration":
              onPitchGenerationTaskFinished(event.task, event.result);
              break;
            case "singingVolumeGeneration":
              onVolumeGenerationTaskFinished(event.task, event.result);
              break;
            case "singingVoiceSynthesis":
              onVoiceSynthesisTaskFinished(event.task, event.result);
              break;
          }
          break;
        case "completed":
          break;
      }
    });

    return taskGraphRunner;
  }

  private buildTaskGraph(
    context: SongTrackRenderingContext,
  ): TaskGraph<SongTrackRenderingContext, SongTrackRenderingTask> {
    const trackPhrasesMap = new Map<TrackId, Map<PhraseKey, PhraseForRender>>();
    for (const trackId of context.snapshot.tracks.keys()) {
      trackPhrasesMap.set(trackId, new Map());
    }
    for (const [phraseKey, phrase] of context.phrases) {
      const trackPhrases = getOrThrow(trackPhrasesMap, phrase.trackId);
      trackPhrases.set(phraseKey, phrase);
    }

    const tasks: SongTrackRenderingTask[] = [];

    for (const [trackId, track] of context.snapshot.tracks) {
      const trackPhraseKeys = [...getOrThrow(trackPhrasesMap, trackId).keys()];

      const queryGenerationTaskMap = new Map<
        PhraseKey,
        FrameAudioQueryGenerationTask
      >();
      for (const phraseKey of trackPhraseKeys) {
        if (track.singer == undefined) {
          continue;
        }
        const queryGenerationTask = new FrameAudioQueryGenerationTask(
          [],
          phraseKey,
          this.config,
          this.engineSongApi,
          this.queryCache,
        );
        queryGenerationTaskMap.set(phraseKey, queryGenerationTask);
        tasks.push(queryGenerationTask);
      }

      const editingAndAdjustingPhonemeTimingTask =
        new EditingAndAdjustingPhonemeTimingTask(
          [...queryGenerationTaskMap.values()],
          trackId,
        );
      tasks.push(editingAndAdjustingPhonemeTimingTask);

      for (const [phraseKey, queryGenerationTask] of queryGenerationTaskMap) {
        const pitchGenerationTask = new SingingPitchGenerationTask(
          [queryGenerationTask, editingAndAdjustingPhonemeTimingTask],
          phraseKey,
          this.config,
          this.engineSongApi,
          this.singingPitchCache,
        );
        tasks.push(pitchGenerationTask);

        const volumeGenerationTask = new SingingVolumeGenerationTask(
          [pitchGenerationTask],
          phraseKey,
          this.config,
          this.engineSongApi,
          this.singingVolumeCache,
        );
        tasks.push(volumeGenerationTask);

        const voiceSynthesisTask = new SingingVoiceSynthesisTask(
          [volumeGenerationTask],
          phraseKey,
          this.engineSongApi,
          this.singingVoiceCache,
        );
        tasks.push(voiceSynthesisTask);
      }
    }

    return new TaskGraph(tasks);
  }

  /**
   * 現在進行中のレンダリング処理の中断を要求する。
   * 中断要求は、次のフレーズのレンダリング処理に移る前にチェックされる。
   * 既に実行中の個々のフレーズレンダリング処理は中断されない。
   *
   * @throws レンダリング処理が進行中でない場合にエラーをスローする。
   */
  requestRenderingInterruption() {
    if (!this._isRendering) {
      throw new Error("Rendering is not in progress.");
    }
    this.interruptionRequested = true;
  }

  /**
   * レンダリングイベントを受け取るリスナー関数を追加する。
   *
   * @param listener イベントを受け取るリスナー関数。
   * @throws 同じリスナー関数が既に登録されている場合にエラーをスローする。
   */
  addEventListener(listener: (event: SongTrackRenderingEvent) => void) {
    const exists = this.listeners.has(listener);
    if (exists) {
      throw new Error("Listener already exists.");
    }
    this.listeners.add(listener);
  }

  /**
   * 登録されているイベントリスナー関数を削除する。
   *
   * @param listener 削除するリスナー関数。
   * @throws 指定されたリスナー関数が存在しない場合にエラーをスローする。
   */
  removeEventListener(listener: (event: SongTrackRenderingEvent) => void) {
    const exists = this.listeners.has(listener);
    if (!exists) {
      throw new Error("Listener does not exist.");
    }
    this.listeners.delete(listener);
  }

  /**
   * 登録されているすべてのリスナーにイベントをディスパッチ（発行）する。
   *
   * @param event 発行するイベントオブジェクト。
   */
  private dispatchEvent(event: SongTrackRenderingEvent) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
