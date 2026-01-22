<template>
  <div class="phoneme-timing-editor">
    <div class="axis-area"></div>
    <div v-if="editTarget === 'PHONEME_TIMING'" class="parameter-area">
      <SequencerParameterGrid
        class="parameter-grid"
        :offsetX="props.viewportInfo.offsetX"
      />
      <SequencerWaveform
        class="waveform"
        :offsetX="props.viewportInfo.offsetX"
      />
      <SequencerNoteTimings
        class="note-timings"
        :offsetX="props.viewportInfo.offsetX"
        :offsetY="props.viewportInfo.offsetY"
      />
      <SequencerPhonemeTimings
        class="phoneme-timings"
        :offsetX="props.viewportInfo.offsetX"
        :offsetY="props.viewportInfo.offsetY"
        :previewPhonemeTimingEdit="phonemeTimingPreviewEdit"
      />
      <div
        ref="interactionLayer"
        class="interaction-layer"
        @pointerdown="onPointerDown"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { ViewportInfo, CursorState } from "@/sing/viewHelper";
import { useStore } from "@/store";
import { usePhonemeTimingEditorStateMachine } from "@/composables/usePhonemeTimingEditorStateMachine";
import {
  onMountedOrActivated,
  onUnmountedOrDeactivated,
} from "@/composables/onMountOrActivate";
import SequencerParameterGrid from "@/components/Sing/SequencerParameterGrid.vue";
import SequencerWaveform from "@/components/Sing/SequencerWaveform.vue";
import SequencerPhonemeTimings from "@/components/Sing/SequencerPhonemeTimings.vue";
import SequencerNoteTimings from "@/components/Sing/SequencerNoteTimings.vue";

const store = useStore();
const editTarget = computed(() => store.state.parameterPanelEditTarget);
const props = defineProps<{
  viewportInfo: ViewportInfo;
}>();

const { stateMachineProcess, cursorState, phonemeTimingPreviewEdit } =
  usePhonemeTimingEditorStateMachine(
    store,
    computed(() => props.viewportInfo),
  );

const interactionLayer = ref<HTMLElement | null>(null);

// カーソルスタイル
const cursorStyle = computed(() => {
  const state: CursorState = cursorState.value;
  switch (state) {
    case "EW_RESIZE":
      return "ew-resize";
    case "DRAW":
      return "crosshair";
    case "ERASE":
      return "crosshair";
    default:
      return "default";
  }
});

// インタラクションレイヤー内のローカル座標を取得
const getLocalPositionX = (event: PointerEvent): number => {
  const layer = interactionLayer.value;
  if (layer == null) {
    return 0;
  }
  const rect = layer.getBoundingClientRect();
  return event.clientX - rect.left;
};

const onPointerDown = (event: PointerEvent) => {
  if (event.button !== 0) {
    return;
  }
  stateMachineProcess({
    type: "pointerEvent",
    targetArea: "PhonemeTimingArea",
    pointerEvent: event,
    positionX: getLocalPositionX(event),
  });
};

const onWindowPointerMove = (event: PointerEvent) => {
  stateMachineProcess({
    type: "pointerEvent",
    targetArea: "Window",
    pointerEvent: event,
    positionX: getLocalPositionX(event),
  });
};

const onWindowPointerUp = (event: PointerEvent) => {
  stateMachineProcess({
    type: "pointerEvent",
    targetArea: "Window",
    pointerEvent: event,
    positionX: getLocalPositionX(event),
  });
};

// イベントリスナー登録（常に登録・解除）
onMountedOrActivated(() => {
  window.addEventListener("pointermove", onWindowPointerMove);
  window.addEventListener("pointerup", onWindowPointerUp);
});

onUnmountedOrDeactivated(() => {
  window.removeEventListener("pointermove", onWindowPointerMove);
  window.removeEventListener("pointerup", onWindowPointerUp);
});
</script>

<style scoped lang="scss">
.phoneme-timing-editor {
  width: 100%;
  height: 100%;
  overflow: hidden;

  display: grid;
  grid-template-columns: 48px 1fr;
}

.axis-area {
  grid-column: 1;
  grid-row: 1;
  border-right: solid 1px var(--scheme-color-sing-piano-keys-right-border);
}

.parameter-area {
  grid-column: 2;
  grid-row: 1;
  overflow: hidden;

  display: grid;
  grid-template-rows: 12px 26px 28px 1fr;
}

.parameter-grid {
  grid-column: 1;
  grid-row: 1 / 5;
}

.waveform {
  grid-column: 1;
  grid-row: 4 / 5;
}

.note-timings {
  grid-column: 1;
  grid-row: 2 / 3;
}

.phoneme-timings {
  grid-column: 1;
  grid-row: 1 / 5;
}

.interaction-layer {
  grid-column: 1;
  grid-row: 1 / 5;
  z-index: 10;
  cursor: v-bind(cursorStyle);
}
</style>
