import React from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { SlackWindow } from "../components/SlackWindow";
import { ChatBubble } from "../components/ChatBubble";
import { BrowserWindow } from "../components/BrowserWindow";

export const Scene5Payoff: React.FC = () => {
  const frame = useCurrentFrame();

  const cardOpacity = interpolate(frame, [10, 35], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const cardY = interpolate(frame, [10, 35], [24, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const seenOpacity = interpolate(frame, [45, 60], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const unfurlOpacity = interpolate(frame, [60, 90], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const unfurlScale = interpolate(frame, [60, 100], [0, 1], {
    easing: Easing.out(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const meiReplyOpacity = interpolate(frame, [165, 195], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const meiReplyX = interpolate(frame, [165, 195], [-30, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        background: "#09090B",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <SlackWindow title="Maya & Mei">
        <div>
          <div style={{ opacity: cardOpacity, transform: `translateY(${cardY}px)` }}>
            <ChatBubble
              side="right"
              avatarSrc={staticFile("avatars/maya.png")}
              name="Maya"
              subtitle="Mobile Engineer 📱"
            >
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 10,
                    background: "#0E1512",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 22,
                  }}
                >
                  📄
                </div>
                <div style={{ display: "flex", flexDirection: "column" }}>
                  <span style={{ fontWeight: 700 }}>phonebook-gallery</span>
                  <span style={{ fontSize: 20, opacity: 0.8 }}>dist/index.html</span>
                </div>
              </div>
            </ChatBubble>
          </div>
          <div
            style={{
              opacity: seenOpacity,
              alignSelf: "flex-end",
              marginRight: 92,
              marginTop: -24,
              marginBottom: 16,
              fontFamily: "system-ui, -apple-system, sans-serif",
              fontSize: 18,
              color: "#71717A",
              textAlign: "right",
            }}
          >
            Seen
          </div>

          <div
            style={{
              opacity: unfurlOpacity,
              transform: `scale(${unfurlScale})`,
              transformOrigin: "top right",
              marginRight: 92,
              alignSelf: "flex-end",
            }}
          >
            <BrowserWindow
              url="dist/index.html"
              style={{ width: 620, height: 440 }}
            >
              <Img
                src={staticFile("demo.png")}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                  objectPosition: "top",
                }}
              />
            </BrowserWindow>
          </div>
        </div>

        <div
          style={{
            opacity: meiReplyOpacity,
            transform: `translateX(${meiReplyX}px)`,
          }}
        >
          <ChatBubble
            side="left"
            avatarSrc={staticFile("avatars/mei.png")}
            name="Mei"
            subtitle="Product Designer"
          >
            wait, this is it?? 🎉
          </ChatBubble>
        </div>
      </SlackWindow>
    </AbsoluteFill>
  );
};
