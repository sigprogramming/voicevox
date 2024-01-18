<template>
  <div ref="canvasContainer" class="canvas-container"></div>
</template>

<script lang="ts">
import {
  defineComponent,
  ref,
  watch,
  onMounted,
  onUnmounted,
  toRaw,
  computed,
} from "vue";
import * as PIXI from "pixi.js";
import { useStore } from "@/store";
import { frequencyToNoteNumber, secondToTick } from "@/sing/domain";
import { noteNumberToBaseY, tickToBaseX } from "@/sing/viewHelper";
import { LineStrip } from "@/sing/webgl/graphics";

type VoicedSection = {
  startFrame: number;
  endFrame: number;
};

type PitchLine = {
  startFrame: number;
  endFrame: number;
  frameTicksArray: number[];
  lineStrip: LineStrip;
};

export default defineComponent({
  name: "SingSequencerPitch",
  props: {
    offsetX: { type: Number, default: 0 },
    offsetY: { type: Number, default: 0 },
  },
  setup(props) {
    const store = useStore();
    const periodicPitches = computed(() => {
      const phrases = Object.values(store.state.phrases);
      return phrases.map((value) => value.query?.periodicPitch);
    });
    const canvasContainer = ref<HTMLElement | null>(null);
    let resizeObserver: ResizeObserver | undefined;

    let renderer: PIXI.Renderer | undefined;
    let stage: PIXI.Container | undefined;
    let requestId: number | undefined;
    let renderInNextFrame = true;

    const pitchLinesMap = new Map<string, PitchLine[]>();

    const searchVoicedSections = (
      periodicPitchData: number[],
      minNumOfFrames: number
    ) => {
      const voicedSections: VoicedSection[] = [];
      let startFrame = 0;
      let prevValue = 0;
      for (let i = 0; i < periodicPitchData.length; i++) {
        const value = periodicPitchData[i];
        if (prevValue === 0 && value !== 0) {
          startFrame = i;
        }
        if (prevValue !== 0 && value === 0) {
          const endFrame = i;
          if (endFrame - startFrame >= minNumOfFrames) {
            voicedSections.push({ startFrame, endFrame });
          }
        }
        prevValue = value;
      }
      if (prevValue !== 0) {
        const endFrame = periodicPitchData.length;
        if (endFrame - startFrame >= minNumOfFrames) {
          voicedSections.push({ startFrame, endFrame });
        }
      }
      return voicedSections;
    };

    const render = () => {
      if (!renderer) {
        throw new Error("renderer is undefined.");
      }
      if (!stage) {
        throw new Error("stage is undefined.");
      }

      const phrases = toRaw(store.state.phrases);
      const tempos = [toRaw(store.state.score.tempos[0])];
      const tpqn = store.state.score.tpqn;
      const zoomX = store.state.sequencerZoomX;
      const zoomY = store.state.sequencerZoomY;
      const offsetX = props.offsetX;
      const offsetY = props.offsetY;

      const pitchLineColor = [0.647, 0.831, 0.678, 1]; // RGBA
      const pitchLineWidth = 1.5;

      // 無くなったフレーズを調べて、そのフレーズに対応するピッチラインを削除する
      const deletedPhraseKeys: string[] = [];
      for (const [phraseKey, pitchLines] of pitchLinesMap) {
        if (!Object.hasOwn(phrases, phraseKey)) {
          deletedPhraseKeys.push(phraseKey);
          // lineStripをステージから削除
          for (const pitchLine of pitchLines) {
            stage.removeChild(pitchLine.lineStrip.displayObject);
          }
        }
      }
      for (const phraseKey of deletedPhraseKeys) {
        pitchLinesMap.delete(phraseKey);
      }
      // ピッチラインの生成・更新を行う
      for (const [phraseKey, phrase] of Object.entries(phrases)) {
        if (!phrase.query || !phrase.startTime || !phrase.query.periodicPitch) {
          continue;
        }
        const pitchStartTicks = secondToTick(phrase.startTime, tempos, tpqn);
        const periodicPitchData = phrase.query.periodicPitch.data;
        const periodicPitchRate = phrase.query.periodicPitch.rate;
        let pitchLines = pitchLinesMap.get(phraseKey);
        // フレーズに対応するピッチラインが無かったら生成する
        if (!pitchLines) {
          // 有声区間を調べる
          const voicedSections = searchVoicedSections(periodicPitchData, 2);
          // 有声区間のピッチラインを生成
          pitchLines = voicedSections.map((value): PitchLine => {
            const startFrame = value.startFrame;
            const endFrame = value.endFrame;
            const numOfFrames = endFrame - startFrame;
            // ticksは前もって計算しておく
            const frameTicksArray: number[] = [];
            for (let j = 0; j < numOfFrames; j++) {
              const ticks =
                pitchStartTicks +
                secondToTick(
                  (startFrame + j) / periodicPitchRate,
                  tempos,
                  tpqn
                );
              frameTicksArray.push(ticks);
            }
            const lineStrip = new LineStrip(
              numOfFrames,
              pitchLineColor,
              pitchLineWidth
            );
            return { startFrame, endFrame, frameTicksArray, lineStrip };
          });
          // lineStripをステージに追加
          for (const pitchLine of pitchLines) {
            stage.addChild(pitchLine.lineStrip.displayObject);
          }
          pitchLinesMap.set(phraseKey, pitchLines);
        }
        // ピッチライン（lineStrip）を更新
        for (let i = 0; i < pitchLines.length; i++) {
          const pitchLine = pitchLines[i];
          const startFrame = pitchLine.startFrame;
          const endFrame = pitchLine.endFrame;
          const numOfFrames = endFrame - startFrame;
          const points: number[][] = [];
          for (let j = 0; j < numOfFrames; j++) {
            const ticks = pitchLine.frameTicksArray[j];
            const baseX = tickToBaseX(ticks, tpqn);
            const viewX = baseX * zoomX - offsetX;
            const value = periodicPitchData[startFrame + j];
            const freq = Math.exp(value);
            const noteNumber = frequencyToNoteNumber(freq);
            const baseY = noteNumberToBaseY(noteNumber);
            const viewY = baseY * zoomY - offsetY;
            points.push([viewX, viewY]);
          }
          pitchLine.lineStrip.setPoints(points);
        }
      }
      renderer.render(stage);
    };

    watch(periodicPitches, () => {
      renderInNextFrame = true;
    });

    watch(
      () => [
        store.state.sequencerZoomX,
        store.state.sequencerZoomY,
        props.offsetX,
        props.offsetY,
      ],
      () => {
        renderInNextFrame = true;
      }
    );

    onMounted(() => {
      const canvasContainerElement = canvasContainer.value;
      if (!canvasContainerElement) {
        throw new Error("canvasContainerElement is null.");
      }

      const canvasElement = document.createElement("canvas");
      canvasElement.width = canvasContainerElement.clientWidth;
      canvasElement.height = canvasContainerElement.clientHeight;
      canvasContainerElement.appendChild(canvasElement);

      renderer = new PIXI.Renderer({
        view: canvasElement,
        backgroundAlpha: 0,
        antialias: true,
      });

      stage = new PIXI.Container();

      const callback = () => {
        if (renderInNextFrame) {
          render();
          renderInNextFrame = false;
        }
        requestId = window.requestAnimationFrame(callback);
      };
      requestId = window.requestAnimationFrame(callback);

      resizeObserver = new ResizeObserver(() => {
        if (renderer == undefined) {
          throw new Error("renderer is undefined.");
        }
        renderer.resize(
          canvasContainerElement.clientWidth,
          canvasContainerElement.clientHeight
        );
        renderInNextFrame = true;
      });
      resizeObserver.observe(canvasContainerElement);
    });

    onUnmounted(() => {
      stage?.destroy();
      renderer?.destroy();
      if (requestId != undefined) {
        window.cancelAnimationFrame(requestId);
      }

      resizeObserver?.disconnect();
    });

    return { canvasContainer };
  },
});
</script>

<style scoped lang="scss">
@use '@/styles/variables' as vars;
@use '@/styles/colors' as colors;

.canvas-container {
  overflow: hidden;
  z-index: 0;
  pointer-events: none;
}
</style>
