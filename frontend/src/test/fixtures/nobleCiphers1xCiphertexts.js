/**
 * FROZEN ciphertext fixture — generated under @noble/ciphers 1.3.0 (issue #1670).
 *
 * Members hold ciphertext produced by the 1.x library: spec-032 encrypted backups, the open-challenge
 * code vault, legacy address-book backup files, and X25519 / X-Wing / code-keyed (XChaCha20) envelopes.
 * Every entry below was produced by OUR OWN encrypt functions (utils/crypto/primitives.js,
 * utils/crypto/envelopeEncryption.js, lib/backup/backupCrypto.js) while 1.3.0 was installed, with a
 * deterministic getRandomValues so the run was reproducible. nobleCiphers1xCompat.test.js decrypts
 * every entry with the CURRENT code and asserts byte-exact plaintext.
 *
 * DO NOT REGENERATE OR EDIT. A failure against this file means the current code can no longer open
 * data members already hold — fix the code, never the fixture.
 *
 * Keys are fixed fill-byte test values (0x11…, 0x33…, 0x55…; recipient seeds 0x41/0x42/0x43), not
 * real key material.
 */

export const NOBLE_CIPHERS_1X_FIXTURE = {
  "nobleCiphersVersion": "1.3.0",
  "primitives": [
    {
      "name": "encrypt/no-aad",
      "fn": "decrypt",
      "keyHex": "1111111111111111111111111111111111111111111111111111111111111111",
      "aad": null,
      "nonce": "931d268feac2a22648629f75",
      "ciphertext": "f38971b6393d4bf001996f8b7b1e86a55705761347596f0af1491ab346687f8ec2626e07c6c7ead77d3e75560907eb86739dffddbc9659",
      "plaintextUtf8": "FairWins 1.x compat — ünïcødé ✓"
    },
    {
      "name": "encrypt/aad",
      "fn": "decrypt",
      "keyHex": "1111111111111111111111111111111111111111111111111111111111111111",
      "aad": "fixture-aad:1",
      "nonce": "b7647bb2a9e347a952b49893",
      "ciphertext": "adc646aec30aff4e52eac320809891c6c0aa1207b6d2c08e339065f184444a59335770bfba5c869bb02116805cd23220ef84aa30802d66",
      "plaintextUtf8": "FairWins 1.x compat — ünïcødé ✓"
    },
    {
      "name": "encryptJson/no-aad",
      "fn": "decryptJson",
      "keyHex": "1111111111111111111111111111111111111111111111111111111111111111",
      "aad": null,
      "nonce": "bc6dc44136d04cd554422d5d",
      "ciphertext": "810e3b3b9d9ea4ba5d91b17a0ed2ac0839b4ab06d07bd01606007e5567e806db65eb093cc03a90a8f7ca88d9713aa887ee9633d4dd5aeba929e60b872b991683fe3ed6fab2b196006aec735155b07e197776fbcf1697590885619fb1b89fbec2e9d7c20c704de0ad6d5524",
      "plaintextJson": {
        "a": 1,
        "nested": {
          "list": [
            1,
            "two",
            null,
            true
          ]
        },
        "s": "FairWins 1.x compat — ünïcødé ✓"
      }
    },
    {
      "name": "encryptJson/aad:backup",
      "fn": "decryptJson",
      "keyHex": "1111111111111111111111111111111111111111111111111111111111111111",
      "aad": "fairwins-data-backup:1",
      "nonce": "d6420dd3e0cac57f75bb4d97",
      "ciphertext": "d63fe083680756960ceab795117e44690e969ad32252991d4e4d4468cf71cf8ecf83b8eded821b6cee673d06c2657fb745b92e953793593a584079787a10d15ea02fab3f248b488ec14cdb0372347297f5d716e245d7280cb3b646bfe2f01d720ad61cbb71f58123058f9a",
      "plaintextJson": {
        "a": 1,
        "nested": {
          "list": [
            1,
            "two",
            null,
            true
          ]
        },
        "s": "FairWins 1.x compat — ünïcødé ✓"
      }
    },
    {
      "name": "encryptJson/aad:code-vault",
      "fn": "decryptJson",
      "keyHex": "1111111111111111111111111111111111111111111111111111111111111111",
      "aad": "fairwins-oc-code-vault:1",
      "nonce": "c9ba631da584eddb5e9c80ae",
      "ciphertext": "c6191bbadee36fdf25cb15c87e400cdccc32261f4f4e823c49b86402fe370a3fbcb40459be7d43c71daaa1fc442a61c97e92d71e566502ec2deaad516d2a4e84558b7ec7020cc7ce1ff3b0409e5af3ab119652bcfb5e83e4b6fcc86a62b6cd37db5921bfe262766630cf25",
      "plaintextJson": {
        "a": 1,
        "nested": {
          "list": [
            1,
            "two",
            null,
            true
          ]
        },
        "s": "FairWins 1.x compat — ünïcødé ✓"
      }
    },
    {
      "name": "encryptJson/aad:address-book-legacy",
      "fn": "decryptJson",
      "keyHex": "1111111111111111111111111111111111111111111111111111111111111111",
      "aad": "fairwins-address-book-backup:1",
      "nonce": "4ba6c61db2c48940f6fad908",
      "ciphertext": "9b1ece2e683c7cd901876c14c2e3e85507bbc1a80152f409313328133f3ea2571702d594276d1378a0f207feb7feca2dc0299b58c274fc86709f1e9b195e60141690428c3b0717e8e172e4a5f14c65a959ca70bd0ab522a3b5402124f1ec07e2822d39b69e8085f4f587bb",
      "plaintextJson": {
        "a": 1,
        "nested": {
          "list": [
            1,
            "two",
            null,
            true
          ]
        },
        "s": "FairWins 1.x compat — ünïcødé ✓"
      }
    }
  ],
  "envelopes": [
    {
      "name": "x25519",
      "kind": "x25519",
      "readers": [
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      ],
      "envelope": {
        "version": "1.0",
        "algorithm": "x25519-chacha20poly1305",
        "signingVersion": 2,
        "content": {
          "nonce": "3ee349e19cfceb9e1c1f2f6d",
          "ciphertext": "f9126c32c92487070d29b799162ca6c562f80965bbaf9899c38eeba382db268aad478b2c4c9a7f1d7f6841f8924206fcf90591aaa35286097439663603056ab29627b4b86875075e1a86a2e98510b09b983539f93e95a52a01df1578077d942b7f02bbf5340457615ab0b08f46f4"
        },
        "keys": [
          {
            "address": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "ephemeralPublicKey": "2d6bab70ff0fa81050983879204fc03a514b51607a08abe6b737dab592d40600",
            "nonce": "1d8c2dc1eba51efbe09493e7",
            "wrappedKey": "25e0a8468ce2c9887ed7ba00f5ee94a98f04b1d67f6649729a00406288ee544a7e9e62deb21e2a46f011b96ff08f92bb"
          },
          {
            "address": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "ephemeralPublicKey": "4cd21fd8828072c5115a72b9c401848474451002a32e8b461ccd0da66a6d6f71",
            "nonce": "8f9fd3eac88d192ecfcda832",
            "wrappedKey": "65a15c1b3e0fde88bac7145a1eaba1debc3853197ea1d12e7858fb00ce1ecfef89af0d69c061248f0f95142286c25d49"
          }
        ]
      },
      "plaintextJson": {
        "title": "Fixture wager",
        "stakeUsdc": "25.00",
        "note": "FairWins 1.x compat — ünïcødé ✓"
      }
    },
    {
      "name": "x25519/terms-aad",
      "kind": "x25519",
      "readers": [
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      ],
      "envelope": {
        "version": "1.0",
        "algorithm": "x25519-chacha20poly1305",
        "signingVersion": 2,
        "termsVersion": {
          "id": "tos-2026-01",
          "hash": "0xabababababababababababababababababababababababababababababababab"
        },
        "content": {
          "nonce": "d8a9bf0185c6f6e08572cc13",
          "ciphertext": "217d2369bae8dfde4b7a71b5e6a298bc44ae4a4c7b5be7072bc9b7524db068451d01b4edbd0ad1faf82db3e0c92a60284f1ea180d6039b186135794e9cec6d9e0c5a7cfbf41298f93a6d2047c5901480d3ca447c12f5ab563c907b8ea8db5416534a197f66fe6497e286dfa3365c"
        },
        "keys": [
          {
            "address": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "ephemeralPublicKey": "307bee8a255887b4cbf8d84247e5cd6c6f4a7717444ab2c00c9e6fb5e6006810",
            "nonce": "3b63063662808f5ea7cbd251",
            "wrappedKey": "3c36e7cbe75eb7990fcc3121b5bbe67fae6d248abe78baf69daa25018b580618d8b77714de25df222f0467aa56bed6cc"
          },
          {
            "address": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "ephemeralPublicKey": "e5980049f0e7f4324e16ce5d668df7fc7f44a2efc92bea5744b9fb0f1e94826a",
            "nonce": "9d9293d5fc2868b0e2fe0562",
            "wrappedKey": "98daf7cde9140fefaed8d98384ef8b7f583dc7845c1c384bafc7e751a7a9e90e5d243b16acf9ccd08800dea97b4b091e"
          }
        ]
      },
      "plaintextJson": {
        "title": "Fixture wager",
        "stakeUsdc": "25.00",
        "note": "FairWins 1.x compat — ünïcødé ✓"
      }
    },
    {
      "name": "x25519/string",
      "kind": "x25519",
      "readers": [
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      ],
      "envelope": {
        "version": "1.0",
        "algorithm": "x25519-chacha20poly1305",
        "signingVersion": 2,
        "content": {
          "nonce": "22a00d8124ab037ea84c7998",
          "ciphertext": "5668ab236d380a35f148a9f765394f805bddbb67a2deff577ea51aa35049de9599ee4cd4"
        },
        "keys": [
          {
            "address": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "ephemeralPublicKey": "dfe18d5deba33eaaa6c2593f21a8aa12b48c594509288dfb2d3e29ff843c4c0c",
            "nonce": "f08051f73a5a5b0a2183b972",
            "wrappedKey": "90a82e5e82b5bac1907e6ad3ab63f79fdd60df9166bf51ccc448cfcacbc92e360ad868ca7a1b641bbcd8265a9e3becb9"
          }
        ]
      },
      "plaintextString": "plain string payload"
    },
    {
      "name": "x25519/addRecipient",
      "kind": "x25519",
      "readers": [
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "0xcccccccccccccccccccccccccccccccccccccccc"
      ],
      "envelope": {
        "version": "1.0",
        "algorithm": "x25519-chacha20poly1305",
        "signingVersion": 2,
        "content": {
          "nonce": "3ee349e19cfceb9e1c1f2f6d",
          "ciphertext": "f9126c32c92487070d29b799162ca6c562f80965bbaf9899c38eeba382db268aad478b2c4c9a7f1d7f6841f8924206fcf90591aaa35286097439663603056ab29627b4b86875075e1a86a2e98510b09b983539f93e95a52a01df1578077d942b7f02bbf5340457615ab0b08f46f4"
        },
        "keys": [
          {
            "address": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "ephemeralPublicKey": "2d6bab70ff0fa81050983879204fc03a514b51607a08abe6b737dab592d40600",
            "nonce": "1d8c2dc1eba51efbe09493e7",
            "wrappedKey": "25e0a8468ce2c9887ed7ba00f5ee94a98f04b1d67f6649729a00406288ee544a7e9e62deb21e2a46f011b96ff08f92bb"
          },
          {
            "address": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "ephemeralPublicKey": "4cd21fd8828072c5115a72b9c401848474451002a32e8b461ccd0da66a6d6f71",
            "nonce": "8f9fd3eac88d192ecfcda832",
            "wrappedKey": "65a15c1b3e0fde88bac7145a1eaba1debc3853197ea1d12e7858fb00ce1ecfef89af0d69c061248f0f95142286c25d49"
          },
          {
            "address": "0xcccccccccccccccccccccccccccccccccccccccc",
            "ephemeralPublicKey": "2b759a07062dcef9bfb8c56e6c8850cfa10e098945c2d348717123c8b0160639",
            "nonce": "1e4830779fad0134c9f811e1",
            "wrappedKey": "51a5e31b2a13bc5a857ffcd788689f702e47d2790960e530378648fcba93ca5cf9823966a2f28e5df4cf91da01da65ce"
          }
        ]
      },
      "plaintextJson": {
        "title": "Fixture wager",
        "stakeUsdc": "25.00",
        "note": "FairWins 1.x compat — ünïcødé ✓"
      }
    },
    {
      "name": "xwing",
      "kind": "xwing",
      "readers": [
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      ],
      "envelope": {
        "version": "2.0",
        "algorithm": "xwing-chacha20poly1305",
        "signingVersion": 2,
        "content": {
          "nonce": "7a25d37ec2b1d1ecc47f68b7",
          "ciphertext": "82737e3cf007ddd98de637450801363c415b1963a9ed7f6ee4d6c8c7dcfdcc4a29a9dad3bef82dbed458cc35bcd0ffba7bfbb7941c5c50a08aade2596a4fc98114ae6784a47a5c1b6300d189248e0069de72ec485f91513ab4fafcfa197a779a274486ab1737c73c5636272bc445"
        },
        "keys": [
          {
            "address": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "xwingCiphertext": "ee90c90721c25f16c6171f46a5b41eeeffc623a5eb03e65af425149499bb63cc3a001a772812a4ce4063c5d856d23b25bb04425ca7360a27902b3acbec940877ac53b32744332d10cdb716947f836f4171a1a5c6aca207902aaf5b9b006543a12dfff8508c305ba4aecc59762e941acb2d7b48a6b36b5d4c3d8e9931d64ffea2c0afd6ab77883dd5c3e1b8bdba9dde8359dd8dfcf4f09edf131cc4d2db35322eed30a220674f2badf43de4c94bdd0e04896ea4d9b70e0595e58b884310a2433b5d079e8453164755b65ffa1e8fb6dd287b056a0bde80aeb8ecba3ebba7b172612aecf96afba2c385b973f521717596093aa4232f65323aa3606ec68941643402b69d03799a34d239e7f0772ef8cc5bc10563b261528e647daf861422ee0857f25b33cd01d5ec1c45f239af336c569e5936d324e1822abd9947ad9e680c4943f983f1175b28c6555ff8f9de0a66d0d4f8c604e3398c67b6c4d3217a208c0e863ab50fa0e5ec8b409ec95a31b86579cbca247daacc8c688427295ff0d7f3226655e90ca0f72be5c75092d0ec314a574e9065844a0dd2b720ca7a9ae96908bc49c68eb693e0ad8fbd6f4389d91a7fc976f26866d4d734ae0057ec6067a875a3022d5556000434aee1f3f6236441c7af6a15dbf97dbbac7baabb2eb576eebf46641837f33cb21db29f957617db4e9cc813163c0b3ddb3367e17dc8bfe83a4d9600fa894553b9f41164a23b7474a215e1e91ca19b7b91787ab843eddb641c700825fd8e810159199121ec2b384ec88278bed47b2543c8d70158a4e1d626ead3a3acbecfc05014fb0871cf5d3b0e0a0caaf32e139b05756d3de05cb7dadb6dec9ceeb1ef2a3ed2ac78bd45b0e9b80367f76b0fba677af9b2ce971e92572a0db07c84c8b382baeab085a60c4f2561e1046e2c2a6056dbd67be882344ac6cbb53603e90c7f78d0a33f8d82e95560ed093ea883c99b137309e4751b130d8d8f0c0350ce2df2210f1587ad404decefd6012a3bfe0ac9c3793d7a274d88452f141c79263ff6482ee6c23327971beae0b63242fc226657356c0c2c7985aa4a64ac3247bd86e2aebd94e25865b2cf76c79030dba66cad59e6ae7c15b255d61ccc55acfa8f12c13c58812dbd544075390c6a785b7c6b395b456871fde157148127803776d516883a1bfad1a4aada180c035446f433a2269162b256c7fe20849662feab6fbd7daf388225266cc8e3fc3f10e15ca28cb6b9a01c422249295a9a4657f6c5e867d42fc7bdedc32110701917937dafd0a8bd8d4111a8fce35e7b260f6e1d86900ec7b9365a44fa62535df07b5a14f096c029edbfcc4efe6c1adcb789d2c8bb8c5fd7d7dcd3fd57443145fed60fe10a6a69c572cb90a1448ddfa980e27085e3432fc6cd367e68ffc6260117f56621052907fe9b317bd852268fc52cf921161f014ef37d805f9c5dc484ade47be57466bbb1ccd6d8dd632dca808092a132170f120abfc736d0b4e74f8fa5bceecde6af58e88f8186d69a41482aa1b4df5e738c7ea8a893f6c9b3d104bda561da043dfa878fd0cbc5d110e183988ac5df577cdc031c230c",
            "nonce": "c9deb0bfbf07852a91c3e0b7",
            "wrappedKey": "7028d91a243d8f78c718292538a8b38a6edcb299406e9c67144a802ab049548730ab70e0fc203fe8948cb8a1f3809d17"
          },
          {
            "address": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "xwingCiphertext": "e0a96abdd15ab92b2a925285fefa252a8ee0c273f3b5821cc778134270dbbd52b25053d63eb358daf5cb2e0fbf2bbf4c7adfaf71dc90b64c97ce77e6d69419765b250a1ba4787701488f0605a19d3b82b3c2c860c0d214a1e7194c0a753b8482c402fee3eae55227097366f0ffaf9c4ff1b1e2bb03458ff6951a51665654017cb312db4a05d7e4120de0343bbb637bcda694ddbe30e3a9ec3f5b3aef75292d3ac9b65ee728e043764059da9cfd3244bea621d99b68b34f5af63e735b706ae53e9d09796df8ce61bdaf1735d7c5c251a5e8ade0c0ca288daa32160666a4c5d8a3e1b8e9537c1f1cc6d2091807a9867dd1ba21fcff25e10636d1584a9cea13d946902ed988b13e94deb70bb7455cf4cf8d4ceca3ec183751f850a819ef3d7a9d97e7a3130c851c0d3c04956b36a408af3fa5168ce3fb314d46571bd99712767c6e8353627699ba06ff6b5bacc7084e26bd38a90070f9946fea5e89920ca6f34c6adea735bdec59cb05474f7a2f6fcfa5666cb45cba6cb4cc768e780103610ef303a4584ae0556a25af8f06e564918b0fe0890e58dc05d377346f67338867fcee6b04b354fdaf11d834e5750daac7c373cda92804b1698e3256eda8ae718cea437c65ecb2ca66e16f41ff7df000900e39a4bc898600dbdb0938906e4b0859e036f4baa25c73d6ca27dba8e2d7d285defea7122459ec97807f568d7641f3eb767ccb401735eb650ccf6a6ee913e83cf5d7dc3c27c3702f9463721816f4096c33434a738c4bd4ec4a250207104f1f7dab411adce87ab185931edc891ee4cf1705acc62fe7f0ba7cc0ba59b7e9e88bf663561d165aeb983881e633fd768502a7294fbcb601fcd6acbda214e9e3f4d4f6202299fa13d2f20db9cbead0966a7936ada58e53120a7a7f313e2ba45952ac17ea765fc6efa690f5349f4e0377b00054c9e1ba23a193422bd103a54ef1f7cda9387edb6e23a77afab3c776b7c402fc6351dd7944a92908812bc6d7120efe51b617e8e676bad1134235fcf22b0d126509988fe1cf7ae66b411958c6d51d188571579de1b4ebd5f6824d428df6c169b258aa6ecb8b044d6d1287d9ec192ccdeca9d1117f22e02e1b8f87fa4f9ee2532e8d994d48e1367b595bb94798c1da603e62be2f7d9a805366798d37354ae3c4915745adb21be41b658c60e9a9546447401a5b334ca82129beed876df5d92cf2b2f23c1a1db0bdfef87f36c4f923febbf5951cb4d5e2d8f9cda70b26e6e9aacb97f19de03a8b3f9f0719b84da33efc790ddebf2092f1af9d61adaafa5ad76dedbd08a98a210dbb7312260cd640c97e0c262f52fbe0d361a60d68d8a62f1008ac23c5dc31663ba7ae9355df0d7f1710af634d675dfb0385e69c2808400f7813fe68121d34fcaf731923d6923d265230e233507bc2fcd45fdbd9edc1b92b19c2647d26e654d21b3bafc8e54fbd6e6da03f1668ead98034a443f6f64434fbccaeac04e8c225ffc226a13f5ac457061ad64ac8b8453196a3cb15e170acf87b9f159732ba852d839822e1e1853abcde259cc5f9e3cd3474ed7fac75c9c8efb0207f6addf4fed14f",
            "nonce": "4244763da1c09563e113e744",
            "wrappedKey": "90a735a4be7cd2baac31e5c902f1e0daf2d9e17aa4300dceeccf3f56e51105cf411061c24f32e9e1b2627f6186437b37"
          }
        ]
      },
      "plaintextJson": {
        "title": "Fixture wager",
        "stakeUsdc": "25.00",
        "note": "FairWins 1.x compat — ünïcødé ✓"
      }
    },
    {
      "name": "xwing/terms-aad",
      "kind": "xwing",
      "readers": [
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      ],
      "envelope": {
        "version": "2.0",
        "algorithm": "xwing-chacha20poly1305",
        "signingVersion": 2,
        "termsVersion": {
          "id": "tos-2026-01",
          "hash": "0xabababababababababababababababababababababababababababababababab"
        },
        "content": {
          "nonce": "1bb51c6e74ecdafff6b7cc9a",
          "ciphertext": "54909697b083b3fac6d478315b9852c32923e9951d705630c9b4ac92f7de5470c4a7ede7f9db014c324f9b8b8db7dee8782c2f6dfa5eaed4be80085e8b9c78cdb3a3cd4f81db20dbbba82cabbcce4ba3d5162177329fd2739ce99b6a147ef8a9ba88ef23b814809b8fb0c39ff030"
        },
        "keys": [
          {
            "address": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "xwingCiphertext": "c9a72fb73e350f2d1e897e8066c6a9308c02a8f1f916878e4b3cb113cfb62a17e2d9b4c944256ee3fbceda6dba35b3e8517086875b53c350725be60fb522aac3768ac27458cdc3a8c6543d5b8027035c31e1b8d12cec14601130e1b86c3b67a40068454d07e932a5f4e05ba55568e4d602bf3d701559123a36634b8ef45ba4c2f75b4d897c5467fa6117c3410c2a3329ad73ef198ed871abc0e539e4b0a985097ca95632be43add9c874ca797ddd4598e1bdbae51af4312c175f8aa40ec699357eb2d8602e2b8b0c4a6c95c23bdf37a2626a1fce0c6048118ec8e237d355009cf5df9cb166948b4fb234ed06e2a6453d023c57963db314450ccf0eb5b77fefc19dcc9747d819515673694de962952803f599e4e859841a350d79362218a712622885f870b6e3ce4b075e4dcf48427fc90cb11e2a91e754ff79af99d8e8aefca715c2a053e683efc3869fd3ba7eb0cbd67bbd5ad1e862ea60c2a774f49ad0b35133498bb29b11747d0f30d1ed8fd6326efb11d117c653c91d1384584ca8802cfa4f75acf3de744f1c5474e1e442fceca73d42c68c7322959423ec40d4bea0aa5942620c35c8a0ac29a37ed3b9d80e5701ddfb23b6bdffb502042db5d8c377cbb8d0c01d73fdf4e00949bbf6d69d01544691faf37f0606fe37adb01e400be045fdbc498ce745be7399c668b0573d1aa998b940e103d3e51b13f85a332b07cde1bc45e2a63ded225b714881301a86fff68bd86d73f90bcaad33baa5ce193a6907d916b65d3ce164fc0600d1be44d7ec2b9a5437fb3e2df53aab7caa4fb2e25578081e822cf9bfe0a049dee80eeb1cc1b78d18f16afc71b2eaf2e22d197fabd584f47bb6f4bb9dc5951eb6da2313bb18ebbfd449b4d2fa5fda7b334c97ed2e68b2f4854652cefab924d95c950ee1d50e364d95a8e06944ae623061297f6319a8a3ec9429d55bf9f905b8878ecf6a5f4b3e4faf3d9c166e1e0ad986dec4ec4f587ebc09a60347a311f8a3435e09c1ac84cd0a9d00c824bd1389805c7ff038d6a88466aca03fe416e92af42567c3f3515efadbcaa5effd2a8bfca13a14c759d3d9bbe01b5046fe681db15efd88fa94c3625eff03ea9bd16cb34ff6409874a69d5a56f1d41e47423cfbd1188934f66448f27f8e5bb7af8909957672313ff86013df38decca1b492499cc546cd89026d4653321e677f534834286a084a52d3e5b18880eb58e4deaade7cdbfb0dadfbda4fe7b8586da909a7a508d340845893726d5a4dca65e4e09b7fd97010c4f540293305d1d288ff8612514dce6481383824852b96f287a679904f1a875975b3e66e610dab80e58580482a816e41b4e0f18bdf506ef327d67cd46393961967768962a0704c49ade662bbeb72399a106721c2fedfe81d6a8757cd5b19a77669b3793d547b6a7bb1545012626b65d7d76a4748d48779a3b50c74cfb5f794364f7cd51f33fb929b7a29d0aee74902c781f194d1380ac52ad50500cc12154e59304e83322b0349b99f62d4d73613ddf953606451da50024d71f254020869c6b6b6eef5a4d47232a78772972a10f2d66a16aae6bf6a489125",
            "nonce": "3e9866cbd24f83cff1f1af21",
            "wrappedKey": "96d2146a52e5b9f0574f7be36e2b8e083ab1a51c224ddcdf30aac4e0e97136b2470928e8a092b30bd552b474be29599f"
          },
          {
            "address": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "xwingCiphertext": "cec2181f2d7abfc638ce296df1b4ecbfb69c6a077d3f260376a346d723454a4390a6137f0182f51afe5bb83242437d1fdadd3250f3af6abc6189d40fc8a6737cbe9db97450ddb5f3c60c0ef41ac7428fe67038eb334fa585db0bd79444c04f07d9b211856666937c97b94c31c8257cbd3613c529f45eb83b71a8d40375287934b22a00fa01070999891f2aed9a2153f578c6f8fe33c2a31aa93a2397096f92f78ba19b4c43d030adf23e510e739b3e34e729a1de513d49a0f50bea1888e3783b9fb41206e580fa4af18f9f89101274048d5df3ebacc2dfd34e5f8db1448083e560d5e8ee30441144d374f6ebf6f1697ab45b2422873e22978a7d628f71ea192b38e31289294412c977cf10beb8c9710f2e3b8ab80f417de010efc0f531712186ca007dfcea5e43908c5964cbe24dd2d4e6007fe2d1679ecb884bbc874292bc18be9fd40df2933babd89da01d5b1c4ae7b09bd85e6327f21c05ed587a34d6e6a3fa62271d99f1a5ea88682d0fa4da4298673f6609e29ebfd67e2492d3a5709506a9ba17bd61159da8065911ae0317b8d1e4f49584b1233dc8c4a375ac6c4ad6b699088eba07edf2c5e44df025fae90cffdf92b0f6fa4e190f7d4518dcd9bb47f665abe5993196128226f795b059d9aa6815a6b8ecd4dac79b01ea3fbb37e403e8a510e9c0664fef11ccae92b02aa1246fee1602698698bfe528857f82081f502e3ea5149b03ef825f7e3806f2c213f67494867b6df689bb542360ff95b45fbe9de6dcec129315858bb1499bb429d2df47a618669c530c7c34b2b0afb20adac6a4a180598601bbdfed2e5cf25de22af7c348eec8f0a3e7761856a193e0260d6a0ee66f86a0f41b7d4be6fb1109394250816bacc2dac4e7b5bfc69c30c5eaa7d73fe8c4673d4b174c383292f8e5d919a0ae82adf0176e079c894298c835efaa0df7775204b9ae143d04de2c24c1bfebdca872d815b95084234edba13ef8cf50a4e84842bb16cfa8fdae2edf70829a373962e2722716810d4e821978d13cbdb2e19c820fb3f75cb6ee705d053f0ac4883f37235e5dab4e65740a2b145ce85cc001507c40990047396865ddf92d1547e0933e0ce6931dc16a41d6e43970d1678de6d0db9dcfb801efb7bd87033a175421f016ad4ac43acb6bc2f9907415d5936558c2c077be65e8deec62f96db624a8284a45d60d1b427d17a1ab83ac350f2c2f58c99731df20878f84d23da313b1a11e57088d74e9b41c4edf5ef261e2651ab1b28c776011b3f885150c964609e70484c3d5510ee095050541d2572282017a34680718729afe3aef4eeeedb51456d0c2f9c4c66c35939ce011ad824a9a12ecc9f58c50ae81116ecb67c9dbe0f4041910efe9c52292ec7181e2a204bf1df5ad6d0de100607332084134eb745a4dfafed55d7909ac08a6084a43b45ef7dda68d58686b710dcaec3f82ba59896f0e0a0d9d2040112087e9376f91df0771fe90d12ab10c12450e33a38222f8c347e2ee7ee5f3e789d07a517249a4b48690c7c9882a64001f8fb496b9476573490cfcb8761d6e02c04c8f36c56c8c8f7685ef5312f89c2d",
            "nonce": "1e49deb19806b9a2668b1ba0",
            "wrappedKey": "7fbb34305592e585ce1acfb6704e019eaa99f773758ad86b8964b29a4ecd1c9b12efd0fc3a19283a87648c1a62bba01a"
          }
        ]
      },
      "plaintextJson": {
        "title": "Fixture wager",
        "stakeUsdc": "25.00",
        "note": "FairWins 1.x compat — ünïcødé ✓"
      }
    },
    {
      "name": "xwing/addRecipient",
      "kind": "xwing",
      "readers": [
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "0xcccccccccccccccccccccccccccccccccccccccc"
      ],
      "envelope": {
        "version": "2.0",
        "algorithm": "xwing-chacha20poly1305",
        "signingVersion": 2,
        "content": {
          "nonce": "7a25d37ec2b1d1ecc47f68b7",
          "ciphertext": "82737e3cf007ddd98de637450801363c415b1963a9ed7f6ee4d6c8c7dcfdcc4a29a9dad3bef82dbed458cc35bcd0ffba7bfbb7941c5c50a08aade2596a4fc98114ae6784a47a5c1b6300d189248e0069de72ec485f91513ab4fafcfa197a779a274486ab1737c73c5636272bc445"
        },
        "keys": [
          {
            "address": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "xwingCiphertext": "ee90c90721c25f16c6171f46a5b41eeeffc623a5eb03e65af425149499bb63cc3a001a772812a4ce4063c5d856d23b25bb04425ca7360a27902b3acbec940877ac53b32744332d10cdb716947f836f4171a1a5c6aca207902aaf5b9b006543a12dfff8508c305ba4aecc59762e941acb2d7b48a6b36b5d4c3d8e9931d64ffea2c0afd6ab77883dd5c3e1b8bdba9dde8359dd8dfcf4f09edf131cc4d2db35322eed30a220674f2badf43de4c94bdd0e04896ea4d9b70e0595e58b884310a2433b5d079e8453164755b65ffa1e8fb6dd287b056a0bde80aeb8ecba3ebba7b172612aecf96afba2c385b973f521717596093aa4232f65323aa3606ec68941643402b69d03799a34d239e7f0772ef8cc5bc10563b261528e647daf861422ee0857f25b33cd01d5ec1c45f239af336c569e5936d324e1822abd9947ad9e680c4943f983f1175b28c6555ff8f9de0a66d0d4f8c604e3398c67b6c4d3217a208c0e863ab50fa0e5ec8b409ec95a31b86579cbca247daacc8c688427295ff0d7f3226655e90ca0f72be5c75092d0ec314a574e9065844a0dd2b720ca7a9ae96908bc49c68eb693e0ad8fbd6f4389d91a7fc976f26866d4d734ae0057ec6067a875a3022d5556000434aee1f3f6236441c7af6a15dbf97dbbac7baabb2eb576eebf46641837f33cb21db29f957617db4e9cc813163c0b3ddb3367e17dc8bfe83a4d9600fa894553b9f41164a23b7474a215e1e91ca19b7b91787ab843eddb641c700825fd8e810159199121ec2b384ec88278bed47b2543c8d70158a4e1d626ead3a3acbecfc05014fb0871cf5d3b0e0a0caaf32e139b05756d3de05cb7dadb6dec9ceeb1ef2a3ed2ac78bd45b0e9b80367f76b0fba677af9b2ce971e92572a0db07c84c8b382baeab085a60c4f2561e1046e2c2a6056dbd67be882344ac6cbb53603e90c7f78d0a33f8d82e95560ed093ea883c99b137309e4751b130d8d8f0c0350ce2df2210f1587ad404decefd6012a3bfe0ac9c3793d7a274d88452f141c79263ff6482ee6c23327971beae0b63242fc226657356c0c2c7985aa4a64ac3247bd86e2aebd94e25865b2cf76c79030dba66cad59e6ae7c15b255d61ccc55acfa8f12c13c58812dbd544075390c6a785b7c6b395b456871fde157148127803776d516883a1bfad1a4aada180c035446f433a2269162b256c7fe20849662feab6fbd7daf388225266cc8e3fc3f10e15ca28cb6b9a01c422249295a9a4657f6c5e867d42fc7bdedc32110701917937dafd0a8bd8d4111a8fce35e7b260f6e1d86900ec7b9365a44fa62535df07b5a14f096c029edbfcc4efe6c1adcb789d2c8bb8c5fd7d7dcd3fd57443145fed60fe10a6a69c572cb90a1448ddfa980e27085e3432fc6cd367e68ffc6260117f56621052907fe9b317bd852268fc52cf921161f014ef37d805f9c5dc484ade47be57466bbb1ccd6d8dd632dca808092a132170f120abfc736d0b4e74f8fa5bceecde6af58e88f8186d69a41482aa1b4df5e738c7ea8a893f6c9b3d104bda561da043dfa878fd0cbc5d110e183988ac5df577cdc031c230c",
            "nonce": "c9deb0bfbf07852a91c3e0b7",
            "wrappedKey": "7028d91a243d8f78c718292538a8b38a6edcb299406e9c67144a802ab049548730ab70e0fc203fe8948cb8a1f3809d17"
          },
          {
            "address": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "xwingCiphertext": "e0a96abdd15ab92b2a925285fefa252a8ee0c273f3b5821cc778134270dbbd52b25053d63eb358daf5cb2e0fbf2bbf4c7adfaf71dc90b64c97ce77e6d69419765b250a1ba4787701488f0605a19d3b82b3c2c860c0d214a1e7194c0a753b8482c402fee3eae55227097366f0ffaf9c4ff1b1e2bb03458ff6951a51665654017cb312db4a05d7e4120de0343bbb637bcda694ddbe30e3a9ec3f5b3aef75292d3ac9b65ee728e043764059da9cfd3244bea621d99b68b34f5af63e735b706ae53e9d09796df8ce61bdaf1735d7c5c251a5e8ade0c0ca288daa32160666a4c5d8a3e1b8e9537c1f1cc6d2091807a9867dd1ba21fcff25e10636d1584a9cea13d946902ed988b13e94deb70bb7455cf4cf8d4ceca3ec183751f850a819ef3d7a9d97e7a3130c851c0d3c04956b36a408af3fa5168ce3fb314d46571bd99712767c6e8353627699ba06ff6b5bacc7084e26bd38a90070f9946fea5e89920ca6f34c6adea735bdec59cb05474f7a2f6fcfa5666cb45cba6cb4cc768e780103610ef303a4584ae0556a25af8f06e564918b0fe0890e58dc05d377346f67338867fcee6b04b354fdaf11d834e5750daac7c373cda92804b1698e3256eda8ae718cea437c65ecb2ca66e16f41ff7df000900e39a4bc898600dbdb0938906e4b0859e036f4baa25c73d6ca27dba8e2d7d285defea7122459ec97807f568d7641f3eb767ccb401735eb650ccf6a6ee913e83cf5d7dc3c27c3702f9463721816f4096c33434a738c4bd4ec4a250207104f1f7dab411adce87ab185931edc891ee4cf1705acc62fe7f0ba7cc0ba59b7e9e88bf663561d165aeb983881e633fd768502a7294fbcb601fcd6acbda214e9e3f4d4f6202299fa13d2f20db9cbead0966a7936ada58e53120a7a7f313e2ba45952ac17ea765fc6efa690f5349f4e0377b00054c9e1ba23a193422bd103a54ef1f7cda9387edb6e23a77afab3c776b7c402fc6351dd7944a92908812bc6d7120efe51b617e8e676bad1134235fcf22b0d126509988fe1cf7ae66b411958c6d51d188571579de1b4ebd5f6824d428df6c169b258aa6ecb8b044d6d1287d9ec192ccdeca9d1117f22e02e1b8f87fa4f9ee2532e8d994d48e1367b595bb94798c1da603e62be2f7d9a805366798d37354ae3c4915745adb21be41b658c60e9a9546447401a5b334ca82129beed876df5d92cf2b2f23c1a1db0bdfef87f36c4f923febbf5951cb4d5e2d8f9cda70b26e6e9aacb97f19de03a8b3f9f0719b84da33efc790ddebf2092f1af9d61adaafa5ad76dedbd08a98a210dbb7312260cd640c97e0c262f52fbe0d361a60d68d8a62f1008ac23c5dc31663ba7ae9355df0d7f1710af634d675dfb0385e69c2808400f7813fe68121d34fcaf731923d6923d265230e233507bc2fcd45fdbd9edc1b92b19c2647d26e654d21b3bafc8e54fbd6e6da03f1668ead98034a443f6f64434fbccaeac04e8c225ffc226a13f5ac457061ad64ac8b8453196a3cb15e170acf87b9f159732ba852d839822e1e1853abcde259cc5f9e3cd3474ed7fac75c9c8efb0207f6addf4fed14f",
            "nonce": "4244763da1c09563e113e744",
            "wrappedKey": "90a735a4be7cd2baac31e5c902f1e0daf2d9e17aa4300dceeccf3f56e51105cf411061c24f32e9e1b2627f6186437b37"
          },
          {
            "address": "0xcccccccccccccccccccccccccccccccccccccccc",
            "xwingCiphertext": "bba384a723ad721225641fbbe74051b6ce4c79d1046adab6f4f257ad7e6306e67d9de6eea94c6b27e984b69efb7dec6dc85f42c2e7ea54ff14d02f7dc39013c428295523ea7c2f76b0ba591c9c10cfd3df72124561edc2dd49354fba01068cd634bf714748cdf34b4fd394f3041000971a8380658a1a90ea09df9bb2f8a2b43da96d946e3fdc21c4dcaf06579879f1002c6b7d733543b95b28a3e28cf4fd817561ceb31ff80fe4a161febf96823c814777aad9cd7a4ccd728650de56147a65fcdfb8e315d0cc8beea5dcf87da5d813925858c3df45b74477f3cb033a9fdab61adf59af8d4d6691e651d36fbe538e74dcbd2de05357d3638c7cb8fdcaa5d2c89f97bef68d7bdfac60116a07dcf2a2a7d549ca22083483752ec226b21281b26a11c9584781dc0f9fa1042f390988d9f805bec85e58a74012edb51229f77c89aa325ae054e8dc66bad64bee918c3184d2b6b30526d3834a9cb3dbd09a34e2bf735d569e958e2f01e4d7082b2f8e881ddb5c323b22cc6ff817751102ac061813ca1bf70dc469692a11bf5e270d5f2a71a993bd9c2c8937365d989766418578d2ef8c27751199b6dccec309ba45fac653459ef7aff208efb116c18e17289ec589be0e1fa93ed21856af1234434cc90074a028c53b74008c75306e1d29e885b61af893c911eea572b77218bc3979e7c4935d9684defd9ae9017da3f65654726a2d68ae0af8dada1cabdba81c9af42d2a236b75ded8ed1c1f7af7ec8ee63c8848f955288f17ba5a9597cb90ca68f7b635918cfce14154a6cb7d3d6373d20c59883dd9d0585677ec8e25ea66f321e5777074d288e7111bf1d71adeda800dbf54ecdcfeedf4e873e525f124c2f6f4986be633cbf7ad7ec97e515c4f4ae0792bf6c0cfe1a77809a2a1b86b3576e7ca0936d3b6f4e89560621430e7134aed5e153766236a2c6fbf301495741c84d80a9eb198edded4ea597f6728caa9438e6b17fb360b8e6c60c794f3e18c64a6a99f9e9bcc9dd1bd4542fa392d4cd2cb538993588cde62d434a2b420e93432725af3958bb3aab85cebc59800853bedab7557dfbcea0f1d8d0927d121b53576bc04514783c2e80c811be099f0eab1a0ce75f5a188c2b3eccfdf0ddb2add5506faa703690dd7a64e9770d8e1e2d58b812f49624b1da903282eddfb3562beda493f1df938e8b124030234c13788380e44fd73be11f86477a8dc815d1ee4e4e135bbb1a007cbbd1fac626cc6d5995e54766c90182d5be08fa7c14f972a95a7ba09689adf354be98d3744593d566618b0ddacb2b2e9a7e84bcb559754bfebc08320459feef110c611a44332bede243d87d189287e4daf7cb70f8133e19a43bc415b238cc38d2d51070cb606eb084733ffd40c4c699012d5665ad92fe5c1ad23eb602750d252680f8616badaa92691a01695734dbd378485c041bb6ed63f15eddc7610d0f69198f2e383362245d6114b841438be5ea008a5a16b1da037392ef5a9fdbc7127cb71207726febd6e627dcd114b91092828a2daec28f8f7850d3de219b57d30a0d8bc43abc204e9f3482567f6f76bde4d8aeccfd0c506",
            "nonce": "f56bff0a6c068eb1c6b8cd32",
            "wrappedKey": "72706349f2488967346ad980cb4c4ea54d54e47b0d1888ddd3db1067bd211f07ed042f2549c7c5cd8e96c884389ca7b5"
          }
        ]
      },
      "plaintextJson": {
        "title": "Fixture wager",
        "stakeUsdc": "25.00",
        "note": "FairWins 1.x compat — ünïcødé ✓"
      }
    }
  ],
  "backupBundle": {
    "keyHex": "3333333333333333333333333333333333333333333333333333333333333333",
    "envelope": {
      "format": "fairwins-data-backup",
      "version": 1,
      "alg": "chacha20poly1305",
      "nonce": "e25ba8bc9be3c0e3fb02671c",
      "ciphertext": "1a78a9233412074f67252822673245b04065d246f81569d8a6a745b589d94ea38edb999f9a3707a2c2fd03fa65ffbbc31931284a46d47ef0f5201345a1901781ee2d6745e25b3059a03fe65d38440cfdd35f0d5e657aa6b5fcedeeabb70b50cbc0743c6aa152039c168f8ec7ef7a7bb32334fd67803a5b40abfe023feaabecd0cc9d"
    },
    "plaintextJson": {
      "schema": 1,
      "objects": {
        "addressBook": [
          {
            "address": "0x2222222222222222222222222222222222222222",
            "label": "Ålice"
          }
        ]
      }
    }
  },
  "recipients": [
    {
      "address": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "seedByte": 65,
      "x25519PublicKey": "cd91f7e236da4f511b738f387442f24fd59ad6fc89fabea247f906e4bddbfc13",
      "xwingPublicKeySha256": "a78a272f6bbd15fe7f9742a43fe377c98e274b87b1eab762fe7cd4694efe730e"
    },
    {
      "address": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "seedByte": 66,
      "x25519PublicKey": "c2b36a80a76c9bad20301c75eece62aed92bc9aef01c60d1271cf514a4056900",
      "xwingPublicKeySha256": "0762dde0865b4aa33be43c5e7f1518d7786063a161414bdf1b997f93a630378e"
    },
    {
      "address": "0xcccccccccccccccccccccccccccccccccccccccc",
      "seedByte": 67,
      "x25519PublicKey": "6dfc6562248960eb24b3dbad4e25fd5a64940b961edc9b7b31ed56bbec0df36d",
      "xwingPublicKeySha256": "9585c724b4891f7859f07d7ea2084fc79205f7d4eda1267dc5d6c208cbddde97"
    }
  ],
  "codeEnvelopes": [
    {
      "name": "code/xchacha",
      "symKeyHex": "5555555555555555555555555555555555555555555555555555555555555555",
      "envelope": {
        "version": "code-1.0",
        "algorithm": "code-xchacha20poly1305",
        "mode": "code",
        "content": {
          "nonce": "689c979a089ef599344798d8158369b384e09651e6afe6e8",
          "ciphertext": "d00aca85accf75dd0d1b8033acea8f6efc3072b7c251c1881f1f03d3b5a8b0e4bbc29b915b14149cc77db002198f341f6b1b702dd109b96601d4704d79bb5d0ebcd6e4e2a36c9dd505b60ba45731dbdb56bddf3f24ffbfa01459cdb9643c43960ec89b31ccd61e71ce14220aaacb"
        }
      },
      "plaintextJson": {
        "title": "Fixture wager",
        "stakeUsdc": "25.00",
        "note": "FairWins 1.x compat — ünïcødé ✓"
      }
    },
    {
      "name": "code/xchacha/terms-aad",
      "symKeyHex": "5555555555555555555555555555555555555555555555555555555555555555",
      "envelope": {
        "version": "code-1.0",
        "algorithm": "code-xchacha20poly1305",
        "mode": "code",
        "termsVersion": {
          "id": "tos-2026-01",
          "hash": "0xabababababababababababababababababababababababababababababababab"
        },
        "content": {
          "nonce": "7fb31f17d9ac680c37cbd46afdbfad1ce8c79ccc7c73c787",
          "ciphertext": "46332abfbb0a162096fa0eba8460b7de2cb6d0afe9078821c0f282c70f9a5d1b61c0b5919e9d428828a885ebc351f05983513fd14a17006d42ede01bf6d792cc01f2a9b5f293fb7cdf88402bce5513581456343af28b781f99e3cfa4463bf3e154e62cd31891b9dbb15dedbdc488"
        }
      },
      "plaintextJson": {
        "title": "Fixture wager",
        "stakeUsdc": "25.00",
        "note": "FairWins 1.x compat — ünïcødé ✓"
      }
    },
    {
      "name": "code/xchacha/string",
      "symKeyHex": "5555555555555555555555555555555555555555555555555555555555555555",
      "envelope": {
        "version": "code-1.0",
        "algorithm": "code-xchacha20poly1305",
        "mode": "code",
        "content": {
          "nonce": "09d3b0b73e2b3ef329fd347c217846c6ed103f67fe39506e",
          "ciphertext": "6be7f6b1c2d4e7b42b4170c327f2b9476d910daa035f6ae708e646e56fa7fd25943ed8"
        }
      },
      "plaintextString": "code string payload"
    }
  ]
}
