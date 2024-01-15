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

export default defineComponent({
  name: "SingSequencerPitch",
  props: {
    offsetX: { type: Number, default: 0 },
    offsetY: { type: Number, default: 0 },
  },
  setup(props) {
    const store = useStore();
    const canvasContainer = ref<HTMLElement | null>(null);
    let resizeObserver: ResizeObserver | undefined;

    let renderer: PIXI.Renderer | undefined;
    let stage: PIXI.Container | undefined;
    let requestId: number | undefined;
    let renderInNextFrame = true;

    const pitchLinesMap = new Map<string, LineStrip[]>();

    const getVoicedSections = (
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

      for (const [key, pitchLines] of pitchLinesMap) {
        if (!Object.hasOwn(phrases, key)) {
          for (const pitchLine of pitchLines) {
            stage.removeChild(pitchLine.mesh as PIXI.DisplayObject);
          }
          pitchLinesMap.delete(key);
        }
      }
      for (const [key, phrase] of Object.entries(phrases)) {
        if (!phrase.query || !phrase.startTime || !phrase.query.periodicPitch) {
          continue;
        }
        const pitchStartTicks = secondToTick(phrase.startTime, tempos, tpqn);
        const periodicPitchData = phrase.query.periodicPitch.data;
        const periodicPitchRate = phrase.query.periodicPitch.rate;
        const voicedSections = getVoicedSections(periodicPitchData, 2);
        let pitchLines = pitchLinesMap.get(key);
        if (!pitchLines) {
          pitchLines = voicedSections.map((value) => {
            const numOfPoints = value.endFrame - value.startFrame;
            const color = [0.647, 0.831, 0.678, 1];
            const width = 1.5;
            return new LineStrip(numOfPoints, color, width);
          });
          for (const pitchLine of pitchLines) {
            stage.addChild(pitchLine.mesh as PIXI.DisplayObject);
          }
          pitchLinesMap.set(key, pitchLines);
        }
        for (let i = 0; i < voicedSections.length; i++) {
          const voicedSection = voicedSections[i];
          const startFrame = voicedSection.startFrame;
          const endFrame = voicedSection.endFrame;
          const numOfFrames = endFrame - startFrame;
          const pitchLine = pitchLines[i];
          for (let j = 0; j < numOfFrames; j++) {
            const value = periodicPitchData[startFrame + j];
            const ticks =
              pitchStartTicks +
              secondToTick((startFrame + j) / periodicPitchRate, tempos, tpqn);
            const baseX = tickToBaseX(ticks, tpqn);
            const viewX = baseX * zoomX - offsetX;
            const freq = Math.exp(value);
            const noteNumber = frequencyToNoteNumber(freq);
            const baseY = noteNumberToBaseY(noteNumber);
            const viewY = baseY * zoomY - offsetY;
            pitchLine.points[2 * j] = viewX;
            pitchLine.points[2 * j + 1] = viewY;
          }
          pitchLine.update();
        }
      }
      renderer.render(stage);
    };

    watch(
      () => [
        Object.values(store.state.phrases).map((value) => value.query),
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
