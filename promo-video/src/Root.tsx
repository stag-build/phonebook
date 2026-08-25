import "./index.css";
import { Composition } from "remotion";
import { PhonebookPromo } from "./PhonebookPromo";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="PhonebookPromo"
        component={PhonebookPromo}
        durationInFrames={815}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};
