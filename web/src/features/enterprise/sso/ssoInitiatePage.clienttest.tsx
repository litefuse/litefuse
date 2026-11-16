/**
 * Characterisation tests for `web/src/pages/auth/sso-initiate.tsx` (batch 3a,
 * cases I1-I5 of docs/ee-independence/03-auth-sso/spec.md §12.10).
 *
 * Author: Select DB — the party that has read the original implementations and
 * therefore owns the specification, the tests and the gates. The implementation
 * is written by Zhang Mo, who never sees the originals; the role convention is
 * documented in docs/ee-independence/README.md.
 *
 * The page's contract: it triggers `signIn` exactly once with the `provider`
 * query value and no second argument, shows the spinner while the call is
 * pending, and turns a rejection into the error page. Copy outside the two
 * non-i18n literals is free to change and is not asserted (the spinner's
 * message gets a " ..." suffix from the component, so it is matched loosely).
 *
 * NOT TESTED: `?provider=a&provider=b` (spec §16.11). The value reaches
 * `signIn` as an array at runtime; the spec records the behaviour as undefined
 * and explicitly asks for no assertion.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { useRouter } from "next/router";
import { signIn } from "next-auth/react";

import SSOInitiate from "@/src/pages/auth/sso-initiate";

jest.mock("next/router", () => ({
  useRouter: jest.fn(),
}));

jest.mock("next-auth/react", () => ({
  signIn: jest.fn(),
  useSession: jest.fn(() => ({ status: "unauthenticated", data: null })),
}));

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
}));

const mockUseRouter = useRouter as unknown as jest.Mock;
const mockSignIn = signIn as unknown as jest.Mock;

const setRouter = (query: Record<string, string>, isReady = true) => {
  mockUseRouter.mockReturnValue({
    query,
    isReady,
    asPath: "/auth/sso-initiate",
    push: jest.fn(),
    replace: jest.fn(),
  });
};

describe("sso-initiate page (I1-I5)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // I1
  it("I1 shows an error and does not call signIn when no provider is given", async () => {
    setRouter({});
    render(<SSOInitiate />);

    expect(
      await screen.findByText(
        "No SSO provider specified. Please contact your administrator.",
      ),
    ).toBeTruthy();
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  // I1 (empty string is the same branch)
  it("I1 treats an empty provider as missing", async () => {
    setRouter({ provider: "" });
    render(<SSOInitiate />);

    expect(
      await screen.findByText(
        "No SSO provider specified. Please contact your administrator.",
      ),
    ).toBeTruthy();
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  // I2
  it("I2 calls signIn once with the provider and no callbackUrl", async () => {
    setRouter({ provider: "acme.test.okta" });
    mockSignIn.mockResolvedValue(undefined);
    render(<SSOInitiate />);

    await waitFor(() => expect(mockSignIn).toHaveBeenCalledTimes(1));
    expect(mockSignIn).toHaveBeenCalledWith("acme.test.okta");
    expect(mockSignIn.mock.calls[0]).toHaveLength(1);
  });

  // I5
  it("I5 keeps showing the redirect spinner while signIn is pending", async () => {
    setRouter({ provider: "acme.test.okta" });
    mockSignIn.mockReturnValue(new Promise(() => {}));
    render(<SSOInitiate />);

    await waitFor(() => expect(mockSignIn).toHaveBeenCalledTimes(1));
    expect(
      screen.getByText(/Redirecting to your identity provider/),
    ).toBeTruthy();
    expect(screen.queryByText(/SSO Sign-in Failed/)).toBeNull();
  });

  // I3
  it("I3 surfaces the message of a rejected Error", async () => {
    setRouter({ provider: "acme.test.okta" });
    mockSignIn.mockRejectedValue(new Error("boom"));
    render(<SSOInitiate />);

    expect(await screen.findByText("boom")).toBeTruthy();
    expect(screen.getByText(/SSO Sign-in Failed/)).toBeTruthy();
  });

  // I4
  it("I4 falls back to the fixed wording for a non-Error rejection", async () => {
    setRouter({ provider: "acme.test.okta" });
    mockSignIn.mockRejectedValue("not an error object");
    render(<SSOInitiate />);

    expect(
      await screen.findByText(
        "Failed to initiate SSO sign-in. Please try again or contact support.",
      ),
    ).toBeTruthy();
  });

  // Not ready: nothing happens until the router is ready.
  it("does nothing while the router is not ready", async () => {
    setRouter({ provider: "acme.test.okta" }, false);
    render(<SSOInitiate />);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockSignIn).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Redirecting to your identity provider/),
    ).toBeTruthy();
  });
});
