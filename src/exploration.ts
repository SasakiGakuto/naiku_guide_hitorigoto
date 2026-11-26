export const explorationSpotIds = ['M01', 'M02', 'M03', 'M04'] as const;

export const explorationIntroOptions = [
  { id: 'exploration-curiosity-a', text: 'この近くには、大きな杉や珍しい鳥居があるんだって。どんな姿をしてるのかなぁ' },
  { id: 'exploration-curiosity-b', text: 'この近くには、ちょっと変わったものがいろいろあるんだって。ぼく、見つけられるかなぁ' },
] as const;

export function chooseExplorationIntro(randomValue: number) {
  return explorationIntroOptions[randomValue < 0.5 ? 0 : 1];
}

export function markSpotDiscovered(discoveredIds: string[], spotId: string) {
  if (!explorationSpotIds.includes(spotId as typeof explorationSpotIds[number]) || discoveredIds.includes(spotId)) {
    return { discoveredIds, added: false };
  }
  return { discoveredIds: [...discoveredIds, spotId], added: true };
}

export function routeStopLabels(spotIds: string[], names: Record<string, string>) {
  return ['大江山口内宮駅（出発）', ...spotIds.map((id) => names[id] ?? id), '大江山口内宮駅（帰着）'];
}
