import { jest } from "@jest/globals";
import { render } from "@testing-library/react";

import { VoicePrint } from "../app/components/voice-print/voice-print";

describe("VoicePrint", () => {
  test("schedules and cancels its animation frame", () => {
    const animationFrame = jest
      .spyOn(window, "requestAnimationFrame")
      .mockReturnValue(42);
    const cancelAnimationFrame = jest
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => undefined);
    const gradient = { addColorStop: jest.fn() };
    const context = {
      clearRect: jest.fn(),
      scale: jest.fn(),
      beginPath: jest.fn(),
      moveTo: jest.fn(),
      quadraticCurveTo: jest.fn(),
      lineTo: jest.fn(),
      closePath: jest.fn(),
      createLinearGradient: jest.fn(() => gradient),
      fill: jest.fn(),
    } as unknown as CanvasRenderingContext2D;
    const getContext = jest
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(context);

    const { unmount } = render(
      <VoicePrint
        frequencies={new Uint8Array([0, 128, 255])}
        isActive
      />,
    );

    expect(animationFrame).toHaveBeenCalledTimes(1);
    unmount();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(42);

    getContext.mockRestore();
    animationFrame.mockRestore();
    cancelAnimationFrame.mockRestore();
  });
});
