import { SetNextState, State } from "@/sing/stateMachine";
import {
  computePhonemeTimingLineInfos,
  findPhonemeTimingLineInfo,
  getPhraseInfosForTrack,
  PhonemeTimingEditorContext,
  PhonemeTimingEditorIdleStateId,
  PhonemeTimingEditorInput,
  PhonemeTimingEditorStateDefinitions,
} from "@/sing/phonemeTimingEditorStateMachine/common";
import { NoteId, TrackId } from "@/type/preload";
import { baseXToTick, getButton } from "@/sing/viewHelper";
import { tickToSecond } from "@/sing/music";
import { clamp } from "@/sing/utility";

export class PhonemeTimingEditState
  implements
    State<
      PhonemeTimingEditorStateDefinitions,
      PhonemeTimingEditorInput,
      PhonemeTimingEditorContext
    >
{
  readonly id = "phonemeTimingEdit";

  private readonly targetTrackId: TrackId;
  private readonly noteId: NoteId;
  private readonly phonemeIndexInNote: number;
  private readonly startPositionX: number;
  private readonly returnStateId: PhonemeTimingEditorIdleStateId;

  private currentPositionX: number;
  private shouldApplyPreview: boolean;

  private innerContext:
    | {
        originalOffsetSeconds: number;
        hasExistingEdit: boolean;
        startTimeSeconds: number;
        minTimeSeconds: number;
        maxTimeSeconds: number;
        frameRate: number;
        previewRequestId: number;
        executePreviewProcess: boolean;
      }
    | undefined;

  constructor(args: {
    targetTrackId: TrackId;
    noteId: NoteId;
    phonemeIndexInNote: number;
    startPositionX: number;
    returnStateId: PhonemeTimingEditorIdleStateId;
  }) {
    this.targetTrackId = args.targetTrackId;
    this.noteId = args.noteId;
    this.phonemeIndexInNote = args.phonemeIndexInNote;
    this.startPositionX = args.startPositionX;
    this.returnStateId = args.returnStateId;

    this.currentPositionX = args.startPositionX;
    this.shouldApplyPreview = false;
  }

  onEnter(context: PhonemeTimingEditorContext) {
    // 音素タイミング情報を計算して取得
    const phraseInfos = getPhraseInfosForTrack(
      context.store.state.phrases,
      context.store.state.phraseQueries,
      this.targetTrackId,
    );
    const lineInfos = computePhonemeTimingLineInfos(
      phraseInfos,
      context.phonemeTimingEditData.value,
      context.tempos.value,
      context.tpqn.value,
      context.viewportInfo.value,
    );
    const lineInfo = findPhonemeTimingLineInfo(
      lineInfos,
      this.noteId,
      this.phonemeIndexInNote,
    );

    if (lineInfo == undefined) {
      throw new Error("PhonemeTimingLineInfo not found.");
    }

    // プレビューデータの初期化
    context.previewPhonemeTimingEdit.value = {
      noteId: this.noteId,
      phonemeIndexInNote: this.phonemeIndexInNote,
      offsetSeconds: lineInfo.originalOffsetSeconds,
    };

    context.previewMode.value = "PHONEME_TIMING_EDIT";
    context.cursorState.value = "EW_RESIZE";

    const previewIfNeeded = () => {
      if (this.innerContext == undefined) {
        throw new Error("innerContext is undefined.");
      }
      if (this.innerContext.executePreviewProcess) {
        this.updatePreview(context);
        this.innerContext.executePreviewProcess = false;
      }
      this.innerContext.previewRequestId =
        requestAnimationFrame(previewIfNeeded);
    };
    const previewRequestId = requestAnimationFrame(previewIfNeeded);

    this.innerContext = {
      originalOffsetSeconds: lineInfo.originalOffsetSeconds,
      hasExistingEdit: lineInfo.hasExistingEdit,
      startTimeSeconds: lineInfo.startTimeSeconds,
      minTimeSeconds: lineInfo.minTimeSeconds,
      maxTimeSeconds: lineInfo.maxTimeSeconds,
      frameRate: lineInfo.frameRate,
      executePreviewProcess: false,
      previewRequestId,
    };
  }

  process({
    input,
    setNextState,
  }: {
    input: PhonemeTimingEditorInput;
    context: PhonemeTimingEditorContext;
    setNextState: SetNextState<PhonemeTimingEditorStateDefinitions>;
  }) {
    if (this.innerContext == undefined) {
      throw new Error("innerContext is undefined.");
    }

    if (input.type === "pointerEvent") {
      const mouseButton = getButton(input.pointerEvent);

      if (
        input.targetArea === "Window" ||
        input.targetArea === "PhonemeTimingArea"
      ) {
        if (input.pointerEvent.type === "pointermove") {
          this.currentPositionX = input.positionX;
          this.innerContext.executePreviewProcess = true;
        } else if (
          input.pointerEvent.type === "pointerup" &&
          mouseButton === "LEFT_BUTTON"
        ) {
          // 編集適用判定: startPositionXとcurrentPositionXの差があれば適用する
          const pixelDelta = Math.abs(
            this.currentPositionX - this.startPositionX,
          );
          this.shouldApplyPreview = pixelDelta >= 1;
          setNextState(this.returnStateId, undefined);
        }
      }
    }
  }

  onExit(context: PhonemeTimingEditorContext) {
    if (this.innerContext == undefined) {
      throw new Error("innerContext is undefined.");
    }

    cancelAnimationFrame(this.innerContext.previewRequestId);

    if (this.shouldApplyPreview) {
      this.applyPreview(context);
    }

    context.previewPhonemeTimingEdit.value = undefined;
    context.cursorState.value = "UNSET";
    context.previewMode.value = "IDLE";
  }

  private updatePreview(context: PhonemeTimingEditorContext) {
    if (this.innerContext == undefined) {
      throw new Error("innerContext is undefined.");
    }
    if (context.previewPhonemeTimingEdit.value == undefined) {
      throw new Error("previewPhonemeTimingEdit is undefined.");
    }

    const viewportInfo = context.viewportInfo.value;
    const tempos = context.tempos.value;
    const tpqn = context.tpqn.value;

    // ピクセル座標からbaseXを計算し、tickを経由して秒に変換
    // これによりテンポ変更を正しく考慮できる
    const startBaseX =
      (this.startPositionX + viewportInfo.offsetX) / viewportInfo.scaleX;
    const currentBaseX =
      (this.currentPositionX + viewportInfo.offsetX) / viewportInfo.scaleX;

    const startTicks = baseXToTick(startBaseX, tpqn);
    const currentTicks = baseXToTick(currentBaseX, tpqn);

    const startSeconds = tickToSecond(startTicks, tempos, tpqn);
    const currentSeconds = tickToSecond(currentTicks, tempos, tpqn);

    const timeDeltaSeconds = currentSeconds - startSeconds;

    // 新しいoffsetSecondsを計算
    // startTimeSeconds + timeDelta が minTimeSeconds と maxTimeSeconds の間になるようにclamp
    const newStartTime = this.innerContext.startTimeSeconds + timeDeltaSeconds;
    const clampedStartTime = clamp(
      newStartTime,
      this.innerContext.minTimeSeconds,
      this.innerContext.maxTimeSeconds,
    );

    // clampedStartTimeとstartTimeSecondsの差分が実際の変化量
    const actualTimeDelta =
      clampedStartTime - this.innerContext.startTimeSeconds;
    const newOffsetSeconds =
      this.innerContext.originalOffsetSeconds + actualTimeDelta;

    context.previewPhonemeTimingEdit.value = {
      noteId: this.noteId,
      phonemeIndexInNote: this.phonemeIndexInNote,
      offsetSeconds: newOffsetSeconds,
    };
  }

  private applyPreview(context: PhonemeTimingEditorContext) {
    if (this.innerContext == undefined) {
      throw new Error("innerContext is undefined.");
    }
    if (context.previewPhonemeTimingEdit.value == undefined) {
      throw new Error("previewPhonemeTimingEdit is undefined.");
    }

    const { offsetSeconds } = context.previewPhonemeTimingEdit.value;

    // フレーム単位に量子化（フレーズごとのframeRateを使用）
    const quantizedOffsetSeconds =
      Math.round(offsetSeconds * this.innerContext.frameRate) /
      this.innerContext.frameRate;

    const phonemeTimingEdit = {
      phonemeIndexInNote: this.phonemeIndexInNote,
      offsetSeconds: quantizedOffsetSeconds,
    };

    if (this.innerContext.hasExistingEdit) {
      // 既存の編集を更新
      void context.store.actions.COMMAND_UPDATE_PHONEME_TIMING_EDITS({
        noteId: this.noteId,
        phonemeTimingEdits: [phonemeTimingEdit],
        trackId: this.targetTrackId,
      });
    } else {
      // 新規に編集を追加
      void context.store.actions.COMMAND_ADD_PHONEME_TIMING_EDITS({
        noteId: this.noteId,
        phonemeTimingEdits: [phonemeTimingEdit],
        trackId: this.targetTrackId,
      });
    }
  }
}
