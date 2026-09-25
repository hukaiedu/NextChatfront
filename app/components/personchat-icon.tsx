import Image from "next/image";

export function PersonChatIcon(props: {
  width?: number;
  height?: number;
  className?: string;
}) {
  const width = props.width ?? 30;
  const height = props.height ?? 30;

  return (
    <Image
      src="/icon.png"
      alt=""
      aria-hidden="true"
      width={width}
      height={height}
      className={props.className}
      style={{ borderRadius: Math.min(width, height) * 0.24 }}
    />
  );
}
