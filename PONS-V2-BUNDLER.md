# Cara Kerja Launch Bundler & Whitelist Buy di PONS Family (Robinhood Chain)

Dokumen ini menjelaskan secara detail bagaimana launch token, whitelist buy (snipe tax
exemption), dan bundler bekerja di platform PONS Family pada Robinhood Chain, serta
bagaimana MegaBot memanfaatkannya.

Semua angka di dokumen ini **dibaca langsung dari kontrak live**, bukan dari asumsi.

| | |
|---|---|
| Jaringan | Robinhood Chain |
| Chain ID | `4663` |
| RPC | `https://rpc.ordofi.network` |
| Waktu blok | **~100 ms** |
| Terakhir diverifikasi | 15 September 2026 |

Waktu blok ~100 ms adalah angka yang menentukan hampir semua keputusan teknis di
dokumen ini. Ingat itu saat membaca bagian bundler.

---

## Daftar Isi

1. [Ringkasan singkat](#1-ringkasan-singkat)
2. [Kontrak yang terlibat](#2-kontrak-yang-terlibat)
3. [Bonding curve — dari mana harga datang](#3-bonding-curve--dari-mana-harga-datang)
4. [Snipe tax — pertahanan anti-sniper PONS](#4-snipe-tax--pertahanan-anti-sniper-pons)
5. [Whitelist buy — `snipeTaxExemptions`](#5-whitelist-buy--snipetaxexemptions)
6. [`launchAndBuy` — semua dalam satu transaksi](#6-launchandbuy--semua-dalam-satu-transaksi)
7. [Pair ERC-20 dan saham tokenisasi](#7-pair-erc-20-dan-saham-tokenisasi)
8. [Bundler — kenapa ini sebuah perlombaan](#8-bundler--kenapa-ini-sebuah-perlombaan)
9. [Tiga mode bundler](#9-tiga-mode-bundler)
10. [Detail implementasi yang menentukan](#10-detail-implementasi-yang-menentukan)
11. [Hasil pengukuran nyata](#11-hasil-pengukuran-nyata)
12. [Batasan — apa yang tidak bisa dilakukan](#12-batasan--apa-yang-tidak-bisa-dilakukan)
13. [Catatan: label phishing di GMGN](#13-catatan-label-phishing-di-gmgn)
14. [Lampiran: konstanta & perintah](#14-lampiran-konstanta--perintah)

---

## 1. Ringkasan singkat

Alur satu launch dari awal sampai akhir:

```
   ┌─ SEBELUM launch (semua perhitungan dikerjakan di sini) ──────────────┐
   │  simulasi launchAndBuy  →  dapat alamat kurva (CREATE2)              │
   │  baca saldo / nonce / fee cap tiap wallet bundle                     │
   │  hitung floor slippage tahan-urutan                                  │
   │  TANDA TANGANI semua transaksi buy wallet bundle                     │
   └──────────────────────────────────────────────────────────────────────┘
                                    ↓
   kirim launchAndBuy  ─→  deploy token + deploy kurva
                           + daftarkan whitelist + dev buy   (1 transaksi)
                                    ↓
                        tunggu receipt  (batas fisik, ~1 blok)
                                    ↓
   broadcast semua transaksi bundle yang sudah ditandatangani
   → mendarat di blok +5, saat snipe tax masih 99% untuk non-whitelist
                                    ↓
   kurva terus dibeli publik sampai reserve nyata = 4,2 ETH
                                    ↓
                    GRADUATION → pool Uniswap V4 (V2MemeHook)
```

Inti keunggulannya bukan koneksi yang lebih cepat, tapi ini: **wallet Anda dibebaskan
dari snipe tax 99%, dan pekerjaan perhitungannya dipindah ke sebelum launch sehingga
wallet Anda tiba sebelum window pajak habis.**

---

## 2. Kontrak yang terlibat

| Peran | Alamat | Nama terverifikasi |
|---|---|---|
| Factory | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` | `PonsV2LaunchFactory` |
| Router launch | `0xe33E9E479dF8802cb0866d5d05258bEc4cF62948` | `PonsV2LaunchAndBuy` |
| Hook pool V4 | `0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044` | `V2MemeHook` |

Status factory saat diverifikasi:

| Field | Nilai |
|---|---|
| `launchFee` | **0,0005 ETH** |
| `maxCreatorTaxBps` | 1000 (10%) |
| `launchEnabled` | `true` |
| `launchConfigCount` | **1** (hanya config `#0` yang ada) |

Setiap token yang di-launch mendapat **kontrak kurva sendiri** (`PonsV2BondingCurve`) —
satu kurva baru per token, bukan pool bersama.

> Source code terverifikasi bisa diambil dari robinscan lewat
> `GET /api/contracts/{address}`. Blockscout API mengembalikan 403, jadi pakai robinscan.

---

## 3. Bonding curve — dari mana harga datang

Token tidak punya likuiditas saat lahir. Ia punya kurva **constant product** dengan
reserve semu:

```
tokensOut = (amountIn × reserveOut) / (reserveIn + amountIn)
```

Config aktif (`launchConfigId = 0`):

| Parameter | Nilai |
|---|---|
| `supply` | 1.000.000.000 token |
| `phantomQuote` | **1,68 ETH** (reserve semu) |
| `graduationThreshold` | **4,2 ETH** (reserve nyata) |
| `curveFeeBps` | 100 (1%) |
| `poolFee` | 0 |
| `tickSpacing` | 200 |

### 3.1 Kenapa ada `phantomQuote`

Kurva memulai dengan **0 ETH nyata**, tapi berpura-pura punya 1,68 ETH.

Tanpa reserve semu ini, pembeli pertama membagi dengan nol dan bisa mendapat seluruh
supply hampir gratis. `phantomQuote` inilah yang memberi token **harga awal**. Ia tidak
pernah bisa ditarik — ia hanya angka di dalam rumus.

### 3.2 Token yang disisihkan untuk graduation

```
reservedTokens = supply × phantomQuote / (phantomQuote + graduationThreshold)
               = 1e9 × 1,68 / (1,68 + 4,2)
               = 28,57% supply     ← disimpan untuk pool V4
sellableTokens = 71,43% supply     ← yang bisa dibeli di kurva
```

Rasio ini identik untuk **setiap** pair yang disetujui (lihat bagian 7) — pasangan
`phantomQuote`/`graduationThreshold` tiap pair selalu dipilih agar graduation share tetap
71,42–71,43%. Itu memang tujuannya: pool yang terbentuk punya kedalaman yang sebanding,
apa pun quote asset-nya.

### 3.3 Detail penetapan harga yang sering disalahpahami

Reserve token yang dipakai menghitung harga adalah **saldo penuh kurva**, bukan porsi
sellable:

```solidity
tokensOut = getAmountOut(
    spent − fee − creatorTax − snipeTax,   // kaki quote SETELAH semua pajak
    quoteReserveBefore,                     // phantom + quote nyata − fee tertahan
    tokenReserveBefore,                     // SELURUH saldo token kurva
    0                                       // fee sudah dipotong di atas
);
```

dengan:

```
quoteReserveBefore = phantomQuote + trackedQuote − quoteFeeBalance − creatorTaxBalance
tokenReserveBefore = trackedTokens        (supply penuh, bukan sellable)
```

Fee yang tertahan **dikeluarkan** dari reserve karena ia bukan lagi milik kurva — ia
menunggu diklaim. Kalau ikut dihitung, harga akan terlihat lebih baik dari yang
sebenarnya bisa dibayar kurva.

`sellableTokens` hanya berlaku sebagai **batas atas**: pembelian yang melewatinya diisi
sebagian, dibebani hanya sebesar yang benar-benar diterima, dan sisa quote dikembalikan.

Ini sengaja tidak ditolak. Pembelian terakhir sebuah launch adalah yang paling rentan
dihitung terhadap state yang sudah digeser orang lain — kalau ia di-revert, siapa pun
bisa menggagalkannya hanya dengan menyelipkan pembelian kecil di depannya.

### 3.4 Graduation

Saat reserve **nyata** mencapai `graduationThreshold` (4,2 ETH), kurva graduate:

1. Kurva berhenti melayani buy/sell
2. Pool Uniswap V4 dibuat, di-key ke `V2MemeHook`
3. Pool diisi dengan 28,57% supply yang disisihkan + quote yang terkumpul

Setelah ini token diperdagangkan di pool V4 normal, bukan lagi di kurva.

---

## 4. Snipe tax — pertahanan anti-sniper PONS

Ini inti dari seluruh persoalan bundler.

Setiap pembelian di detik-detik pertama dikenai pajak yang **meluruh dengan pergeseran
bit**:

```
snipeTaxBps = snipeTaxStartBps >> floor(elapsed × 14 / snipeTaxSeconds)
```

Nilai live di factory:

| Parameter | Nilai |
|---|---|
| `snipeTaxStartBps` | **9900** (99%) |
| `snipeTaxSeconds` | **3** detik |

Tabel peluruhan sebenarnya:

| Waktu setelah launch | Pajak | Efek nyata |
|---|---|---|
| **t+0s** | **9900 bps = 99,00%** | belanja 1 ETH → hanya 0,01 ETH jadi token |
| t+1s | 618 bps = 6,18% | |
| t+2s | 19 bps = **0,19%** | praktis gratis |
| t+3s | 0 bps = 0,00% | window selesai |

**Kenapa digeser 14 kali?** Karena 2¹⁴ = 16384 cukup besar untuk menghabiskan 9900 sampai
nol. Jadi pajaknya benar-benar mencapai 0 di dalam window, bukan terputus mendadak saat
nilainya masih besar.

Dua hal penting:

- **Pajak diambil dari kaki quote SEBELUM penetapan harga.** Jadi sniper di detik nol
  tidak "membeli token mahal" — ia menyerahkan 99% belanjanya ke fee. Ini desain yang
  memang efektif.
- **Pajak dihitung per penerima** (`currentSnipeTaxBps(recipient)`). Jadi bundle tidak
  bisa menghindarinya dengan merutekan semua pembelian melalui satu wallet.

---

## 5. Whitelist buy — `snipeTaxExemptions`

Di sinilah pembuat token mendapat keistimewaan yang tidak dimiliki sniper.

Saat launch, creator bisa mendaftarkan daftar alamat yang **dibebaskan dari snipe tax
secara permanen**. Wallet di daftar itu membeli di detik nol dengan pajak **0 bps**,
sementara alamat di luar daftar kena **9900 bps** di detik yang sama.

### 5.1 Batasan keras

| Batas | Nilai | Alasan |
|---|---|---|
| Ceiling kontrak | **32** alamat | di atasnya `_exemptFromSnipeTax` revert `ExemptionListTooLong` |
| Yang boleh Anda kirim | **31** alamat | router menambahkan `recipient` (dev wallet) ke daftar |

### 5.2 Hanya bisa didaftarkan saat launch

Ini yang paling menentukan: **daftar exemption hanya bisa dikirim di dalam transaksi
launch.**

Tidak ada cara menambahnya sesudahnya — bahkan oleh creator sendiri. Kurva hanya menerima
exemption dari factory, dan factory hanya mengirimkannya di dalam proses launch.

Konsekuensi praktisnya: kalau grup wallet Anda lebih dari 31, kelebihannya akan kena
snipe tax penuh **permanen**. MegaBot menolak melanjutkan tanpa persetujuan eksplisit
untuk kasus ini, karena itu bukan hal yang enak ditemukan setelah launch fee terbayar.

### 5.3 Daftar ini publik

Exemption dikirim sebagai **calldata transaksi launch**. Siapa pun bisa membacanya, dan
ia permanen di on-chain.

Tidak ada mode bundler yang bisa menyembunyikannya. Ini bukan keterbatasan MegaBot — ini
sifat dari cara kontraknya menerima whitelist.

---

## 6. `launchAndBuy` — semua dalam satu transaksi

Factory sendiri tidak bisa melipat dev buy ke dalam launch. Router `PonsV2LaunchAndBuy`
yang melakukannya.

```solidity
launchAndBuy(
    tokenParams,          // nama, simbol, metadata, logo, socials
    launchConfigId,       // 0
    pairToken,            // address(0) untuk ETH native
    quoteIn,              // besar dev buy
    minTokensOut,         // floor slippage
    recipient,            // penerima dev buy
    snipeTaxExemptions    // whitelist, maks 31
)
```

Satu transaksi mengerjakan empat hal berurutan:

1. Deploy kontrak token
2. Deploy kurvanya (CREATE2)
3. Daftarkan `snipeTaxExemptions`
4. Eksekusi dev buy pertama

Karena keempatnya atomik, **tidak ada celah blok** antara kurva lahir dan dev buy.
Sniper tidak bisa menyelip di depan pembelian creator. Dev buy selalu aman.

### 6.1 Aturan `msg.value` — eksak, bukan minimum

```solidity
expectedValue = nativeQuote ? launchFee + quoteIn : launchFee;
if (msg.value != expectedValue) revert NativeValueMismatch(expectedValue, msg.value);
```

Perhatikan `!=`, bukan `<`. Ini sudah diuji langsung ke router live:

| `msg.value` dikirim | Hasil |
|---|---|
| `launchFee` saja (pair native) | lolos cek value, gagal lebih jauh di validasi token |
| `launchFee + quoteIn` | benar |
| `launchFee + quoteIn − 1 wei` | revert `NativeValueMismatch` (`0xbc760cfe`) |

Kelebihan **maupun** kekurangan 1 wei sama-sama ditolak. Tidak ada toleransi.

### 6.2 Pin ekonomi

`expectedEconomics` adalah digest dari syarat kurva yang Anda baca sebelum launch. Kalau
owner factory mengubah parameter tepat saat launch Anda in-flight, transaksinya revert
`LaunchEconomicsMismatch` daripada diam-diam berjalan di harga yang berbeda dari yang
Anda setujui.

---

## 7. Pair ERC-20 dan saham tokenisasi

Selain ETH native, PONS menyetujui 11 quote asset lain. Semua nilai di bawah **dibaca
langsung** dari `pairTokenEconomics()` di factory:

| Pair | Alamat | Dec | `phantomQuote` | `graduationThreshold` |
|---|---|---|---|---|
| **USDG** | `0x5fc5360d0400a0fd4f2af552add042d716f1d168` | **6** | 3.236 | 8.090 |
| NVDA | `0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec` | 18 | 16,64 | 41,6 |
| TSLA | `0x322f0929c4625ed5bad873c95208d54e1c003b2d` | 18 | 10,4 | 26 |
| SPCX | `0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea` | 18 | 28,88 | 72,2 |
| AAPL | `0xaf3d76f1834a1d425780943c99ea8a608f8a93f9` | 18 | 9,68 | 24,2 |
| MSFT | `0xe93237c50d904957cf27e7b1133b510c669c2e74` | 18 | 6,431455767077268559 | 16,078639417693171399 |
| SNAP | `0xf6589f11bc40b669e584073f428b05562f568733` | 18 | 719,274418604651247932 | 1798,186046511628119831 |
| SPY | `0x117cc2133c37b721f49de2a7a74833232b3b4c0c` | 18 | 4,36 | 10,9 |
| QQQ | `0xd5f3879160bc7c32ebb4dc785f8a4f505888de68` | 18 | 4,458589950261094614 | 11,146474875652736535 |
| BB | `0x48e39e56acdba37b09020c0b734a613c9a2f100a` | 18 | 503,824570024570146772 | 1259,561425061425366930 |
| F | `0x25c288e6d899b9bc30160965ad9644c67e73be0c` | 18 | 284,566776859504164031 | 711,416942148760410079 |

Dua hal yang wajib diperhatikan:

- **USDG memakai 6 desimal.** Jangan pernah asumsikan 18 desimal untuk pair ini.
- **Jangan menurunkan `graduationThreshold` dari `phantomQuote × 2,5`.** Rasionya
  mendekati itu, tapi lima pair punya nilai presisi penuh yang tidak bulat (MSFT, SNAP,
  QQQ, BB, F) — hasil derivasi akan melenceng di desimal bawah. Baca nilai aslinya.

Semua pair punya graduation share **71,42%** (config native membaca 71,43%). Jarak kecil
ini berasal dari pembulatan integer `mulDiv`, bukan dari perbedaan kebijakan.

### 7.1 Perbedaan mekanik: ditarik, bukan dikirim

```solidity
// Native (pairToken == address(0))
require(msg.value == amount);

// ERC-20
if (msg.value != 0) revert UnexpectedNativeValue();
safeTransferFrom(token, msg.sender, address(curve), amount);
// dikreditkan berdasarkan DELTA SALDO, bukan angka yang diminta
```

Tiga implikasi:

1. Creator harus **approve router** dulu, bukan mengirim value
2. `msg.value` hanya berisi `launchFee` — kirim lebih dari itu akan revert
3. Kredit dihitung dari **selisih saldo nyata**, jadi token fee-on-transfer otomatis
   tertangani dengan benar

### 7.2 Sebaran penggunaan nyata

Dari 299 transaksi `launchAndBuy` yang berhasil didekode:

| Quote asset | Porsi |
|---|---|
| ETH native | **86,6%** |
| USDG | 5,4% |
| NVDA | 3,3% |
| TSLA | 1,3% |
| SPCX | 1,0% |
| AAPL | 0,7% |
| lainnya | 0,3% |
| **total ERC-20** | **13,4%** |

> Catatan koreksi: angka "28% pakai stock pair" yang sempat saya sebut sebelumnya
> **salah**. Itu mencampur field `isStock` per-token di robinscan dengan `pairToken` yang
> sebenarnya dipakai saat launch. Angka yang benar adalah 13,4%.

---

## 8. Bundler — kenapa ini sebuah perlombaan

Dev buy sudah aman (bagian 6). **Yang berlomba adalah wallet bundle.**

Masalahnya struktural: kurva belum ada sampai transaksi launch tereksekusi. Jadi wallet
bundle wajib membeli **setelah** launch confirm — dan mereka hanya punya window 3 detik
sebelum sniper bisa masuk dengan pajak nol.

### 8.1 Kenapa cara lama kalah

Yang membuat pendekatan lama lambat bukan jaringan, tapi **aritmetika**. Semua ini dulu
dikerjakan **setelah** launch confirm:

- baca saldo tiap wallet
- ambil & dekripsi private key
- baca nonce tiap wallet
- baca fee cap
- polling sampai kurva terlihat
- di dalam viem: fetch chain id + estimasi gas, **per wallet**

Di latensi RPC venue ini (median ~245 ms, ekor sampai 6,4 detik), itu beberapa detik
terbuang. Hasil terukurnya: wallet bundle mendarat di **blok +18**, 2 detik setelah
launch — jauh di luar window.

### 8.2 Kuncinya: alamat kurva bisa diprediksi

Kurva dibuat dengan **CREATE2 dari salt yang kita pilih sendiri**. Artinya simulasi
`launchAndBuy` mengembalikan alamat kurva **sebelum apa pun dikirim ke jaringan**.

Itu membuka semuanya. Ternyata **tidak satu pun** item di daftar 8.1 benar-benar
membutuhkan launch sudah terjadi:

| Yang dibutuhkan | Bisa didapat sebelum launch dari |
|---|---|
| alamat kurva | simulasi CREATE2 |
| reserve awal | config factory, digeser oleh dev buy kita sendiri yang ukurannya kita pilih |
| saldo, nonce, fee cap | pembacaan RPC biasa |
| private key | keystore lokal |

Jadi seluruhnya dipindah ke **depan** launch. Setiap wallet keluar dari tahap persiapan
sebagai **transaksi yang sudah ditandatangani penuh**. Yang tersisa di detik launch hanya
satu hal: `eth_sendRawTransaction`.

Menunda launch selama satu round trip persiapan tidak ada biayanya, karena **launch tidak
berlomba dengan siapa pun — launch adalah yang dilombakan.**

---

## 9. Tiga mode bundler

| Mode | Cara kerja | Kelebihan | Kekurangan |
|---|---|---|---|
| **Atomic** | 1 transaksi untuk semua penerima via `PonsBundleExecutor`, dipin ke reserve yang kita hitung | Satu-satunya yang benar-benar **anti front-run**: revert kalau ada yang beli lebih dulu | Tidak bisa terisi sebagian. Pola 1 pembayar + N penerima dalam 1 TX = klaster paling mudah dibaca. **Belum di-deploy** |
| **Pre-signed** | N transaksi, semua ditandatangani sebelum launch dikirim | Tercepat yang tersedia sekarang | Tiap wallet TX sendiri → bisa terisi sebagian, tidak bersyarat terhadap sniper |
| **Berurutan** | Kutip & kirim satu per satu setelah launch, dengan jeda teracak | Paling terlihat organik | Paling lambat — sniper bisa mendahului |

**Status `PonsBundleExecutor`:** sudah diverifikasi 14/14 lewat `eth_call` dengan state
override, tapi **belum di-deploy** dan alamatnya tidak di-hardcode. Alasannya: kontrak ini
memegang dana beberapa wallet dalam satu panggilan, jadi ia menunggu review pihak ketiga
dulu. Mode atomic saat ini fallback ke pre-signed.

Mode atomic tetap memakai `planSequentialBuys` (urutan di dalam satu TX memang
deterministik). Mode pre-signed memakai `planConcurrentBuys` — lihat 10.3.

---

## 10. Detail implementasi yang menentukan

Empat hal ini yang membuat perbedaan antara bundle yang mendarat dan bundle yang gagal
serentak.

### 10.1 Fee cap, bukan gas price

Transaksi launch membakar **~3,7 juta gas**. Itu mengangkat base fee blok berikutnya di
atas harga yang dibaca sebelum launch.

Dulu ini menjatuhkan **seluruh bundle sekaligus** dengan
`fee cap cannot be lower than the block base fee` — empat wallet gagal serentak, dan tidak
ada satu pun transaksi on-chain untuk ditunjuk sebagai penyebab.

Sekarang dipakai EIP-1559 cap dengan kelonggaran:

```
maxFeePerGas = baseFee × 6 + tip
```

Cap adalah **plafon, bukan pembayaran**. Kalau fee tidak benar-benar naik, kelonggaran itu
gratis — Anda tetap membayar base fee sebenarnya.

### 10.2 Polling receipt 100 ms

Default `waitForTransactionReceipt` viem adalah **4000 ms**. Di rantai dengan blok 100 ms,
angka itu sendirian bisa menahan bundle lebih lama daripada seluruh window 3 detik yang
diperlombakan.

```ts
createPublicClient({ transport: http(rpc), pollingInterval: 100 })
```

Bug yang sama pernah membuat panic sell terasa sangat lambat — lihat catatan di 10.5.

### 10.3 Floor slippage tahan-urutan (permutation-safe)

Ini yang paling halus.

N transaksi independen diurutkan oleh **sequencer**, bukan oleh kita. Kalau tiap wallet
dihargai secara berurutan (wallet 1 pertama, wallet 2 kedua, dst), wallet pertama
mendapat floor paling optimis. Tapi kalau ia justru **mendarat terakhir**, ia menghadapi
harga terburuk sambil membawa floor terbaik → **revert**.

Selisih harga posisi pertama vs terakhir pada 4 wallet sekitar **0,6%** — cukup untuk
memicu revert pada floor yang ketat.

Solusinya: setiap wallet dihargai **seolah semua wallet lain sudah membeli lebih dulu**.
Itu batas terburuk untuk urutan apa pun, jadi floor-nya valid untuk **semua** permutasi.

```
prepareCurveBundle → planConcurrentBuys()    // pre-signed: urutan tak diketahui
                     planSequentialBuys()    // atomic: urutan deterministik
```

### 10.4 Cadangan gas per wallet

```
CURVE_GAS_RESERVE     = 0,0008 ETH
CURVE_BUY_GAS_LIMIT   = 300.000
CURVE_APPROVE_GAS_LIMIT = 90.000
```

`CURVE_GAS_RESERVE` disisakan di setiap wallet supaya wallet itu masih bisa **menjual**
nanti. Tanpa ini, bundle bisa berakhir dengan wallet memegang token yang tidak bisa
dijual karena tidak ada gas — bentuk kegagalan yang paling menjengkelkan, karena baru
terasa saat Anda ingin keluar.

### 10.5 Catatan terkait: kenapa panic sell dulu lambat

Bukan satu bug, tapi tiga sekaligus:

| Bug | Akibat |
|---|---|
| Loop `for` berurutan | `PANIC_CONCURRENCY` dibuang begitu saja |
| `waitForTransactionReceipt` tanpa `pollingInterval` | menunggu 4000 ms di rantai 100 ms |
| Approve sebesar saldo tepat | setiap sell harus approve ulang → 2× transaksi |

Perbaikannya: fan-out pada `PANIC_CONCURRENCY`, `pollingInterval: 100`, dan approve
`2^256 − 1` sekali saja.

Fan-out **hanya aktif saat panik** (`slippageBps >= 9000` atau `action === 'panic_sell'`).
Untuk sell normal ia tetap berurutan — kurva punya satu reserve bersama, jadi sell
konkuren dengan slippage yang mengikat akan membuat wallet-wallet belakangan revert.

---

## 11. Hasil pengukuran nyata

Diukur dari launch sungguhan, bukan simulasi.

**Launch yang diukur**

| | |
|---|---|
| TX | `0xe7524933547b86905e7f0ee728a6365b07f00e6646150320ae08cc3e7821b7c9` |
| Blok | 62225040 |
| Token | `0xba7acf0fac4682b722397c1e562a9c4a1f47f609` |
| Kurva | `0xB170595e30aaD7D7Cf61B5Af978a536A12DF34b4` |
| Mode | pre-signed |

**Perbandingan**

| Metrik | Sebelum (berurutan) | Sesudah (pre-signed) |
|---|---|---|
| Wallet bundle mendarat | blok **+18**, 2 detik | blok **+5**, **0 detik** |
| Wallet berhasil | 1 | **4 / 4** |
| Sniper mendahului | — | **0** |
| Pangsa token 10 detik pertama | — | **100%** |

Baseline "sebelum" diukur dari launch GLOOP
`0x7e1d95decbff656c6c7259a900859c36b03db6c76dbde3f67e2e755237d74176` (blok 59595189).

Tiga wallet bundle masuk di **blok yang sama** — txIndex 2, 3, dan 4.

Yang penting: pada blok +5, snipe tax masih **9900 bps** untuk siapa pun yang tidak
di-whitelist. Jadi wallet Anda membeli dengan pajak **0%** tepat saat semua orang lain
menghadapi **99%**.

---

## 12. Batasan — apa yang tidak bisa dilakukan

Bagian ini penting untuk ekspektasi yang benar.

### Blok +1 adalah batas fisik, bukan +0

Kurva tidak punya kode sampai launch tereksekusi. Dan panggilan `buy` ke alamat tanpa
kode **tidak revert** — ETH-nya hanya berpindah dan **tersangkut** di alamat masa depan
kurva.

Jadi broadcast wajib menunggu receipt launch. Yang bisa dihapus hanyalah **perhitungan**,
bukan penantian itu sendiri.

### Whitelist tidak bisa disembunyikan

`snipeTaxExemptions` adalah calldata publik dan permanen. Tidak ada mode bundler yang
mengubah fakta itu. Permintaan untuk menyembunyikannya dari alat analisis klaster
(misalnya Bubblemaps) **secara teknis tidak mungkin** dipenuhi.

### Sniper tidak bisa dicegah, hanya dikalahkan harganya

Mereka tetap bisa membeli di detik nol. Bedanya, mereka menyerahkan 99% belanjanya ke fee
sementara wallet Anda tidak. Itu keunggulan ekonomi, bukan penguncian.

### Hanya mode Atomic yang benar-benar anti front-run

Pre-signed hanya bisa **datang lebih cepat** — ia tidak bersyarat. Kalau sniper entah
bagaimana mendahului, transaksi pre-signed tetap membeli di harga baru itu (sebatas
floor slippage). Atomic akan **revert** alih-alih membeli. Dan Atomic belum di-deploy.

### Simulasi ERC-20 dengan state override tidak tersedia

Semua token pair yang disetujui **tidak terverifikasi**, dan layout storage-nya tidak
berhasil ditemukan (sudah diprobe slot 0..40 plus kedua varian ERC-7201 dengan sentinel
read-back; dukungan override sendiri terbukti berfungsi lewat override `code`).

Menebak slot lalu menyebutnya bukti adalah penalaran sirkular, jadi jalur ini
ditinggalkan. Uji ERC-20/USDG perlu dilakukan dengan dana nyata dalam jumlah kecil,
mulai dari tombol dry-run.

---

## 13. Catatan: label phishing di GMGN

Temuan terpisah, dicatat di sini karena sering dikaitkan (salah) dengan bundler.

Tiga launch dari deployer yang sama (`0x78AB8050…d5D6BD`):

| Token | Label phishing | Logo | Deskripsi | Twitter | Metadata | Exemptions |
|---|---|---|---|---|---|---|
| MADUSA | **100%** | `gateway.pinata.cloud` | kosong | `x.com/madusa` | 2/7 | 10 |
| QUMA #1 | 0% | `ipfs://` | terisi | `x.com/Qumahood` | 3/7 | 0 |
| QUMA #2 | 0% | `gateway.pinata.cloud` | kosong | `x.com/qumahood` | 2/7 | 3 |

**Kesimpulan: penyebabnya kemungkinan handle Twitter, BUKAN MegaBot.**

QUMA #2 di-launch **via MegaBot**, dengan logo gateway yang sama, deskripsi kosong yang
sama, kelengkapan metadata yang sama, dan tetap memakai exemptions — dan mendapat **0%**.

Itu mengeliminasi: URI logo, deskripsi kosong, kelengkapan metadata, penggunaan
`snipeTaxExemptions`, dan "di-launch via MegaBot". Variabel yang tersisa hanya handle
Twitter: `x.com/madusa` (generik, tidak cocok dengan nama token) vs `x.com/qumahood`
(cocok).

Pemeriksaan on-chain MADUSA vs QUMA #1 **identik**: kurva memegang 100,0000%, non-kurva
0,0000%, dan 8 wallet bundle MADUSA memegang 0. Klaim GMGN "Top 10 100%" tidak didukung
data on-chain — itu memang benar karena kurva memegang semuanya sebelum ada yang beli.

**Caveat yang harus disebut:** formula GMGN tidak diketahui, 3 sampel bukan bukti, dan
selisih 10 vs 3 exemptions belum sepenuhnya diisolasi.

### Perbaikan logo (alasannya bukan phishing)

Handler upload di `apps/client/src/app/pons/page.tsx` diubah ke
`setLogo(res.ipfsUri || res.url)`.

Alasannya **permanensi**, bukan phishing: URL gateway menjadikan metadata on-chain token
Anda bergantung permanen pada endpoint HTTP satu perusahaan. `ipfs://` tidak.

---

## 14. Lampiran: konstanta & perintah

### 14.1 Konstanta

```
# Jaringan
CHAIN_ID                  4663
RPC                       https://rpc.ordofi.network
BLOCK_TIME                ~100 ms

# Kontrak
PONS_V2_FACTORY           0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e
PONS_V2_LAUNCH_AND_BUY    0xe33E9E479dF8802cb0866d5d05258bEc4cF62948
PONS_V2_MEME_HOOK         0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044

# Factory
launchFee                 0,0005 ETH
maxCreatorTaxBps          1000
snipeTaxStartBps          9900
snipeTaxSeconds           3
launchConfigCount         1

# Config #0
supply                    1e9
curveFeeBps               100
phantomQuote              1,68e18
graduationThreshold       4,2e18
poolFee                   0
tickSpacing               200
reservedTokens            28,57%
sellableTokens            71,43%

# Batas exemption
MAX_SNIPE_TAX_EXEMPTIONS  32
MAX_DECLARED_EXEMPTIONS   31

# Gas
CURVE_GAS_RESERVE         0,0008 ETH
CURVE_BUY_GAS_LIMIT       300.000
CURVE_APPROVE_GAS_LIMIT   90.000
burstFeeCaps              baseFee × 6 + tip
```

### 14.2 Script pengukuran & probe

```bash
# Ukur satu launch: berapa blok bundle mendarat, ada sniper mendahului?
RPC=https://rpc.ordofi.network npx tsx scripts/measure-pons-launch.mts --tx 0x…

# Bandingkan dua launch berdampingan
npx tsx scripts/compare-pons-launches.mts --a 0x… --b 0x…

# Simulasi launch ERC-20
npx tsx scripts/simulate-pons-erc20-launch.mts --creator 0x… --curve 0x…

# Probe pair yang disetujui & penggunaannya
npx tsx scripts/probe-pons-approved-pairs.mts
npx tsx scripts/probe-pons-pair-usage.mts
npx tsx scripts/probe-pons-usdg-curve.mts
npx tsx scripts/check-quote-assets-endpoint.mts

# Cek kesiapan sebelum launch (parameter factory, saldo, approve)
npx tsx scripts/preflight-pons-launch.mts

# Verifikasi PonsBundleExecutor lewat eth_call + state override (tanpa deploy)
npx tsx scripts/verify-pons-bundle-executor.mts
```

`probe-pons-approved-pairs.mts` adalah cara tercepat memperbarui tabel di bagian 7 —
ia membaca `pairTokenEconomics()` untuk setiap pair dan sekaligus menguji
`resolveQuoteAsset()` terhadap factory live.

### 14.3 Endpoint

```
GET /uniswap-v4/pons-v2/quote-assets    # daftar pair yang disetujui + desimal + config
```

### 14.4 Gotcha yang perlu diketahui

| Masalah | Penanganan |
|---|---|
| robinscan `/api/addresses/{a}/txs` rate-limit | butuh backoff + jeda ~1,2 s per halaman |
| robinscan tidak mengembalikan calldata | pakai `eth_getTransactionByHash` untuk input |
| Blockscout API 403 | pakai robinscan `/api/contracts/{addr}` untuk source terverifikasi |
| Retensi log RPC publik pendek | **ukur launch segera setelah terjadi**, jangan ditunda |
| `mapWithConcurrency` | mengembalikan `PromiseSettledResult[]`, bukan nilai langsung |

---

*Dokumen ini mencerminkan state on-chain per 15 September 2026. Parameter factory bisa
diubah owner — verifikasi ulang dengan script di 14.2 sebelum mengandalkan angka di sini
untuk launch bernilai besar.*
