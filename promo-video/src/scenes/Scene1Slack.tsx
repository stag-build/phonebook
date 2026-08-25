import React from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { ChatBubble } from "../components/ChatBubble";
import { SlackWindow } from "../components/SlackWindow";

const NEAR_BLACK = "#09090B";
const ZINC_DARK = "#52525B";

/** Fade + slide entrance used by chat bubbles in this scene. */
const entrance = (frame: number, start: number, end: number, fromX: number) => {
  const progress = interpolate(frame, [start, end], [0, 1], {
    easing: Easing.out(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return {
    opacity: progress,
    transform: `translate(${(1 - progress) * fromX}px, ${(1 - progress) * 20}px)`,
  };
};

const Seen: React.FC<{ frame: number; appearAt: number; align: "left" | "right" }> = ({
  frame,
  appearAt,
  align,
}) => {
  if (frame < appearAt) {
    return null;
  }
  const opacity = interpolate(frame, [appearAt, appearAt + 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        opacity,
        alignSelf: align === "left" ? "flex-start" : "flex-end",
        marginLeft: align === "left" ? 92 : 0,
        marginRight: align === "right" ? 92 : 0,
        marginTop: -20,
        fontFamily: "system-ui, -apple-system, sans-serif",
        fontSize: 16,
        fontWeight: 500,
        color: ZINC_DARK,
        letterSpacing: 0.3,
      }}
    >
      Seen ✓✓
    </div>
  );
};

export const Scene1Slack: React.FC = () => {
  const frame = useCurrentFrame();

  const meiEntrance = entrance(frame, 15, 35, -30);
  const mayaEntrance = entrance(frame, 75, 95, 30);

  return (
    <AbsoluteFill
      style={{
        background: NEAR_BLACK,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <SlackWindow title="Maya & Mei">
        <div>
          <div style={meiEntrance}>
            <ChatBubble
              side="left"
              avatarSrc={staticFile("avatars/mei.png")}
              name="Mei"
              subtitle="Product Designer"
            >
              why can&apos;t you just give me a Storybook like web does?
            </ChatBubble>
          </div>
          <Seen frame={frame} appearAt={55} align="left" />
        </div>

        <div>
          <div style={mayaEntrance}>
            <ChatBubble
              side="right"
              avatarSrc={staticFile("avatars/maya.png")}
              name="Maya"
              subtitle="Mobile Engineer 📱"
              muted
            >
              I just can&apos;t.
            </ChatBubble>
          </div>
        </div>
      </SlackWindow>
    </AbsoluteFill>
  );
};
