import React from "react";

export type SlackWindowProps = {
  title: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
};

export const SlackWindow: React.FC<SlackWindowProps> = ({
  title,
  children,
  style,
}) => {
  return (
    <div
      style={{
        width: 1180,
        borderRadius: 20,
        background: "#161618",
        border: "1px solid #2A2A2E",
        boxShadow: "0 40px 100px rgba(0,0,0,0.5)",
        overflow: "hidden",
        ...style,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "20px 28px",
          borderBottom: "1px solid #2A2A2E",
          background: "#1C1C1F",
        }}
      >
        <div style={{ display: "flex", gap: 10 }}>
          <span style={dotStyle("#FF5F57")} />
          <span style={dotStyle("#FEBC2E")} />
          <span style={dotStyle("#28C840")} />
        </div>
        <span
          style={{
            marginLeft: 12,
            fontFamily: "system-ui, -apple-system, sans-serif",
            fontWeight: 600,
            fontSize: 22,
            color: "#D4D4D8",
          }}
        >
          {title}
        </span>
      </div>
      <div style={{ padding: "56px 56px", display: "flex", flexDirection: "column", gap: 44 }}>
        {children}
      </div>
    </div>
  );
};

const dotStyle = (color: string): React.CSSProperties => ({
  width: 16,
  height: 16,
  borderRadius: "50%",
  background: color,
  display: "inline-block",
});
