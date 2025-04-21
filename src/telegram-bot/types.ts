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
