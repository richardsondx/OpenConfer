import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SecretField } from "./SecretField";

describe("SecretField", () => {
  it("shows a masked input for a saved secret, not on-file copy", () => {
    render(
      <SecretField
        label="API secret"
        value=""
        onChange={vi.fn()}
        savedPreview="…cret"
      />,
    );

    expect(screen.queryByText(/on file/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/ends with/i)).not.toBeInTheDocument();
    const input = screen.getByLabelText(/api secret/i) as HTMLInputElement;
    expect(input).toHaveAttribute("type", "password");
    expect(input.value.length).toBeGreaterThan(0);
  });

  it("reveals the saved preview when Show is clicked", () => {
    render(
      <SecretField
        label="API secret"
        value=""
        onChange={vi.fn()}
        savedPreview="…cret"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /show secret/i }));
    const input = screen.getByLabelText(/api secret/i) as HTMLInputElement;
    expect(input).toHaveAttribute("type", "text");
    expect(input.value).toBe("…cret");
  });

  it("replaces the stand-in when the user types a new value", () => {
    const onChange = vi.fn();
    render(
      <SecretField
        label="API key"
        value=""
        onChange={onChange}
        savedPreview="…vkey"
      />,
    );

    fireEvent.change(screen.getByLabelText(/api key/i), {
      target: { value: "new-secret" },
    });
    expect(onChange).toHaveBeenCalledWith("new-secret");
  });

  it("masks a known read-only secret until Show is clicked", () => {
    render(
      <SecretField
        label="Access key"
        value="oc_full_secret_token"
        onChange={vi.fn()}
        readOnly
      />,
    );

    const input = screen.getByLabelText(/access key/i) as HTMLInputElement;
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("readonly");
    expect(input.value).toBe("oc_full_secret_token");

    fireEvent.click(screen.getByRole("button", { name: /show secret/i }));
    expect(input).toHaveAttribute("type", "text");
    expect(input.value).toBe("oc_full_secret_token");
  });
});
