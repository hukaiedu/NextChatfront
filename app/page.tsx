import { Analytics } from "@vercel/analytics/react";

import { Home } from "./components/home";
import { AuthGate } from "./components/auth-gate";
import { getServerSideConfig } from "./config/server";

const serverConfig = getServerSideConfig();

export default async function App() {
  return (
    <>
      <AuthGate>
        <Home />
      </AuthGate>
      {serverConfig?.isVercel && (
        <>
          <Analytics />
        </>
      )}
    </>
  );
}
