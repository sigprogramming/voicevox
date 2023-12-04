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
  toRefs,
  toRaw,
} from "vue";
import * as PIXI from "pixi.js";
import { useStore } from "@/store";
import { frequencyToNoteNumber } from "@/sing/domain";
import { noteNumberToBaseY, tickToBaseX } from "@/sing/viewHelper";
import pitchLineVertexShaderSource from "@/shaders/pitchLineVertexShader.glsl?raw";
import fragmentShaderSource from "@/shaders/fragmentShader.glsl?raw";

const generateSectorVertices = (
  startAngle: number,
  arcAngle: number,
  radius: number
) => {
  const resolution = Math.max(
    1,
    Math.round((arcAngle * 4) / Math.PI),
    radius * 2 * arcAngle
  );
  const geometry: number[][] = [];
  for (let i = 0; i < resolution; i++) {
    const theta0 = startAngle + (arcAngle * (i + 0)) / resolution;
    const theta1 = startAngle + (arcAngle * (i + 1)) / resolution;
    geometry.push([0, 0]);
    geometry.push([Math.cos(theta0) * radius, -Math.sin(theta0) * radius]);
    geometry.push([Math.cos(theta1) * radius, -Math.sin(theta1) * radius]);
  }
  return geometry;
};

const generateRectangleVertices = (
  x: number,
  y: number,
  width: number,
  height: number
) => {
  return [
    [x, y],
    [x, y + height],
    [x + width, y + height],
    [x, y],
    [x + width, y + height],
    [x + width, y],
  ];
};

export class PitchLine {
  readonly mesh: PIXI.Mesh<PIXI.Shader>;
  readonly points: Float32Array;
  private readonly buffer: PIXI.Buffer;

  constructor(numOfPoints: number, color: number[], width: number) {
    if (numOfPoints < 2) {
      throw new Error("The number of points must be at least 2.");
    }
    const shader = PIXI.Shader.from(
      pitchLineVertexShaderSource,
      fragmentShaderSource,
      { color }
    );
    const points = new Float32Array(numOfPoints * 2);
    const buffer = new PIXI.Buffer(points, false);
    const vertices = this.generateSegmentVertices(width);
    const geometry = new PIXI.Geometry();
    geometry.instanced = true;
    geometry.instanceCount = numOfPoints - 1;
    geometry.addAttribute("pos", vertices.flat(), 3);
    geometry.addAttribute(
      "p1",
      buffer,
      2,
      false,
      PIXI.TYPES.FLOAT,
      4 * 2,
      0,
      true
    );
    geometry.addAttribute(
      "p2",
      buffer,
      2,
      false,
      PIXI.TYPES.FLOAT,
      4 * 2,
      4 * 2,
      true
    );
    this.points = points;
    this.buffer = buffer;
    this.mesh = new PIXI.Mesh(geometry, shader);
  }

  private generateSegmentVertices(width: number) {
    const rectangleVertices = generateRectangleVertices(
      -(width / 2),
      0,
      width,
      1
    );
    const leftSectorVertices = generateSectorVertices(
      Math.PI / 2,
      Math.PI,
      width / 2
    );
    const rightSectorVertices = generateSectorVertices(
      -Math.PI / 2,
      Math.PI,
      width / 2
    );
    if (width < 2) {
      return rectangleVertices.map((value) => [
        -(width / 2) + width * value[1],
        value[0],
        value[1],
      ]);
    } else {
      return [
        ...rectangleVertices.map((value) => [0, ...value]),
        ...leftSectorVertices.map((value) => [...value, 0]),
        ...rightSectorVertices.map((value) => [...value, 1]),
      ];
    }
  }

  update() {
    this.buffer.update(this.points);
  }
}

type VoicedSection = {
  startFrame: number;
  endFrame: number;
};

export default defineComponent({
  name: "SingSequencerPitch",
  props: {
    offsetX: { type: Number, default: 0 },
    offsetY: { type: Number, default: 0 },
    canvasWidth: { type: Number, default: 100 },
    canvasHeight: { type: Number, default: 100 },
  },
  setup(props) {
    const { canvasWidth, canvasHeight } = toRefs(props);
    const store = useStore();
    const canvasContainer = ref<HTMLElement | null>(null);

    let renderer: PIXI.Renderer | undefined;
    let ticker: PIXI.Ticker | undefined;
    let stage: PIXI.Container | undefined;

    const pitchLinesMap = new Map<string, PitchLine[]>();

    const secondToTickForConstantBpm = (
      seconds: number,
      bpm: number,
      tpqn: number
    ) => {
      const quarterNotesPerMinute = bpm;
      const quarterNotesPerSecond = quarterNotesPerMinute / 60;
      return seconds * quarterNotesPerSecond * tpqn;
    };

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

    const update = () => {
      if (!renderer) {
        throw new Error("renderer is undefined.");
      }
      if (!stage) {
        throw new Error("stage is undefined.");
      }

      const phrases = toRaw(store.state.phrases);
      const tempo = toRaw(store.state.score.tempos[0]);
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
        const pitchStartTicks = secondToTickForConstantBpm(
          phrase.startTime,
          tempo.bpm,
          tpqn
        );
        const periodicPitchData = phrase.query.periodicPitch.data;
        const periodicPitchRate = phrase.query.periodicPitch.rate;
        const voicedSections = getVoicedSections(periodicPitchData, 2);
        let pitchLines = pitchLinesMap.get(key);
        if (!pitchLines) {
          pitchLines = voicedSections.map((value) => {
            const numOfPoints = value.endFrame - value.startFrame;
            const color = [0.647, 0.831, 0.678, 1];
            const width = 1.5;
            return new PitchLine(numOfPoints, color, width);
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
              secondToTickForConstantBpm(
                (startFrame + j) / periodicPitchRate,
                tempo.bpm,
                tpqn
              );
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

    watch([canvasWidth, canvasHeight], () => {
      if (!renderer) {
        throw new Error("renderer is undefined.");
      }
      const width = Math.ceil(canvasWidth.value);
      const height = Math.ceil(canvasHeight.value);
      renderer.resize(width, height);
    });

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

      ticker = new PIXI.Ticker();
      ticker.add(update);
      ticker.start();
    });

    onUnmounted(() => {
      ticker?.destroy();
      stage?.destroy();
      renderer?.destroy();
    });

    return {
      canvasContainer,
    };
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
