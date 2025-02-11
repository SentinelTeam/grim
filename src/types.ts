import { z } from "zod";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";

export interface Player {
  id: number;
  name: string;
  role: string;
}

export interface UserInteraction {
  type: UserInteractionType;
  player: Player;
  content: string;
}

export enum UserInteractionType {
  INFO = 'INFO',
  FEED = 'FEED',
  ACTION = 'ACTION'
}

const ScenarioTimelineSchema = z.array(z.object({
  datetime: z.string(),
  event: z.string(),
}));

export const PrivateInfoSchema = z.object({
  scenarioTimeline: ScenarioTimelineSchema,
  scratchpad: z.string(),
});

export type PrivateInfo = z.infer<typeof PrivateInfoSchema>;


export const ScenarioUpdateSchema = z.object({
  privateInfo: PrivateInfoSchema,
  currentDateTime: z.string(),
  playerBriefing: z.string(),
});

export type ScenarioUpdate = z.infer<typeof ScenarioUpdateSchema>