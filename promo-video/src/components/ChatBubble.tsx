import React from "react";
import { Img } from "remotion";

export type ChatBubbleProps = {
  side: "left" | "right";
  avatarSrc: string;
  name: string;
  subtitle?: string;
  muted?: boolean;
  style?: React.CSSProperties;
  children: React.ReactNode;
};

const ACCENT = "#4C8C6B";
const MUTED_BG = "#2A2A2E";

export const ChatBubble: React.FC<ChatBubbleProps> = ({
  side,
  avatarSrc,
  name,
  subtitle,
  muted,
  style,
  children,
}) => {
  const isRight = side === "right";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: isRight ? "row-reverse" : "row",
        alignItems: "flex-start",
        gap: 20,
        width: "100%",
        ...style,
      }}
    >
      <Img
        src={avatarSrc}
        style={{
          width: 72,
          height: 72,
          borderRadius: "50%",
          objectFit: "cover",
          flexShrink: 0,
          border: `3px solid ${isRight ? ACCENT : "#3F3F46"}`,
        }}
      />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: isRight ? "flex-end" : "flex-start",
          maxWidth: 640,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 10,
            marginBottom: 8,
            flexDirection: isRight ? "row-reverse" : "row",
          }}
        >
          <span
            style={{
              fontFamily: "system-ui, -apple-system, sans-serif",
              fontWeight: 700,
              fontSize: 26,
              color: "#F7F7F8",
            }}
          >
            {name}
          </span>
          {subtitle ? (
            <span
              style={{
                fontFamily: "system-ui, -apple-system, sans-serif",
                fontWeight: 500,
                fontSize: 20,
                color: "#A1A1AA",
              }}
            >
              {subtitle}
            </span>
          ) : null}
        </div>
        <div
          style={{
            background: muted ? MUTED_BG : isRight ? ACCENT : "#3F3F46",
            color: muted ? "#A1A1AA" : "#F7F7F8",
            opacity: muted ? 0.85 : 1,
            borderRadius: 22,
            borderTopLeftRadius: isRight ? 22 : 6,
            borderTopRightRadius: isRight ? 6 : 22,
            padding: "20px 28px",
            fontFamily: "system-ui, -apple-system, sans-serif",
            fontSize: 28,
            fontWeight: 500,
            lineHeight: 1.35,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
};
