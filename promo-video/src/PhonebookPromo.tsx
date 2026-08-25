import React from "react";
import { Audio, interpolate, Series, staticFile, useCurrentFrame } from "remotion";
import { Scene1Slack } from "./scenes/Scene1Slack";
import { Scene2Sting } from "./scenes/Scene2Sting";
import { Scene3And4Terminal } from "./scenes/Scene3And4Terminal";
import { Scene5Payoff } from "./scenes/Scene5Payoff";
import { Scene6Outro } from "./scenes/Scene6Outro";
import { MusicCredit } from "./components/MusicCredit";

const TOTAL_DURATION = 815;

const MusicBed: React.FC = () => {
  const frame = useCurrentFrame();
  const volume = interpolate(
    frame,
    [0, 8, TOTAL_DURATION - 20, TOTAL_DURATION - 2],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  return <Audio src={staticFile("audio/promo-music.mp3")} volume={volume} />;
};

export const PhonebookPromo: React.FC = () => {
  return (
    <>
      <MusicBed />
      <Series>
        <Series.Sequence durationInFrames={150}>
          <Scene1Slack />
        </Series.Sequence>
        <Series.Sequence durationInFrames={65}>
          <Scene2Sting />
        </Series.Sequence>
        <Series.Sequence durationInFrames={260}>
          <Scene3And4Terminal />
        </Series.Sequence>
        <Series.Sequence durationInFrames={230}>
          <Scene5Payoff />
        </Series.Sequence>
        <Series.Sequence durationInFrames={110}>
          <Scene6Outro />
        </Series.Sequence>
      </Series>
      <MusicCredit />
    </>
  );
};
