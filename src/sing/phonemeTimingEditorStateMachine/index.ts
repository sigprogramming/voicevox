import {
  PhonemeTimingEditorStateDefinitions,
  PhonemeTimingEditorInput,
  PhonemeTimingEditorContext,
  PhonemeTimingEditorIdleStateId,
} from "./common";
import { PhonemeTimingEditToolIdleState } from "./states/phonemeTimingEditToolIdleState";
import { PhonemeTimingEditState } from "./states/phonemeTimingEditState";
import { StateMachine } from "@/sing/stateMachine";

export const createPhonemeTimingEditorStateMachine = (
  context: PhonemeTimingEditorContext,
  initialState: PhonemeTimingEditorIdleStateId,
) => {
  return new StateMachine<
    PhonemeTimingEditorStateDefinitions,
    PhonemeTimingEditorInput,
    PhonemeTimingEditorContext
  >(
    {
      phonemeTimingEditToolIdle: () => new PhonemeTimingEditToolIdleState(),
      phonemeTimingEdit: (args) => new PhonemeTimingEditState(args),
    },
    context,
    initialState,
  );
};
