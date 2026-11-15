// main.ts — titik masuk forge: hidupkan server, daftarkan diri ke
// lingkungan lomba, lalu tunggu sampai lingkungan bilang selesai.
//
// Urutan kerja (kontrak lifecycle):
//   1. nyalakan HTTP server di port ephemeral (port 0, dipilih sistem)
//   2. POST {"port": N} ke $MAKEFUN_ENV_URL/register
//   3. poll GET $MAKEFUN_ENV_URL/done sampai {"done": true}
//   4. tutup server, keluar dengan kode 0
//
// Port 8080 tidak pernah dipakai: port itu milik suite penilai.

import { createApp } from "./lib/app.ts";

const POLL_DELAY_MS = 500;

function tunggu(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nyalakan(server: ReturnType<typeof createApp>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => {
      const alamat = server.address();
      if (alamat === null || typeof alamat === "string") {
        reject(new Error("server tidak mendapatkan alamat listen"));
        return;
      }
      resolve(alamat.port);
    });
  });
}

function matikan(server: ReturnType<typeof createApp>): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function daftarkan(envUrl: string, port: number): Promise<void> {
  const balasan = await fetch(`${envUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ port }),
  });
  if (!balasan.ok) {
    throw new Error(`register gagal: HTTP ${balasan.status}`);
  }
}

async function tungguSelesai(envUrl: string): Promise<void> {
  for (;;) {
    const balasan = await fetch(`${envUrl}/done`);
    if (balasan.ok) {
      const isi = (await balasan.json()) as { done?: unknown };
      if (isi.done === true) return;
    }
    await tunggu(POLL_DELAY_MS);
  }
}

async function jalan(): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (!envUrl) {
    throw new Error("MAKEFUN_ENV_URL belum disetel");
  }
  const server = createApp();
  const port = await nyalakan(server);
  try {
    await daftarkan(envUrl, port);
    await tungguSelesai(envUrl);
  } finally {
    await matikan(server);
  }
}

jalan()
  .then(() => process.exit(0))
  .catch((galat: unknown) => {
    console.error(galat instanceof Error ? galat.message : galat);
    process.exit(1);
  });
