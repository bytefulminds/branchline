import type { QuestContext, QuestPlan, Reply, Round } from "../types/quest";
import { call } from "./git";

export const questService = {
  /** The files of the quest between `base` and `head`, in round order. */
  plan: (repo: string, base: string, head: string) =>
    call<QuestPlan>("quest_plan", { repo, base, head }),
  /** The AI's questions about one file. Cancel with `cancel(opId)`. */
  round: (repo: string, context: QuestContext, opId: string) =>
    call<Round>("quest_round", { repo, context, opId }),
  /** The AI's response to an open answer. */
  reply: (
    repo: string,
    context: QuestContext & { question: string; answer: string },
    opId: string,
  ) => call<Reply>("quest_reply", { repo, context, opId }),
  cancel: (opId: string) => call<void>("cancel_remote_operation", { opId }),
};
