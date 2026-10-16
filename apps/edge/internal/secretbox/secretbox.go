// Package secretbox encrypts PSA credentials at rest with this host's data key (AES-256-GCM).
// The associated data binds each ciphertext to its connection and field, so a value cannot be
// moved to another row and still decrypt.
package secretbox

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
)

type Box struct{ aead cipher.AEAD }

func New(key []byte) (*Box, error) {
	if len(key) != 32 {
		return nil, errors.New("data key must be 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Box{aead: aead}, nil
}

func (b *Box) Seal(plaintext []byte, associatedData string) (ciphertext, nonce []byte, err error) {
	nonce = make([]byte, b.aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return nil, nil, err
	}
	return b.aead.Seal(nil, nonce, plaintext, []byte(associatedData)), nonce, nil
}

func (b *Box) Open(ciphertext, nonce []byte, associatedData string) ([]byte, error) {
	if len(nonce) != b.aead.NonceSize() {
		return nil, errors.New("invalid nonce")
	}
	return b.aead.Open(nil, nonce, ciphertext, []byte(associatedData))
}

// AD is the associated data for a credential field.
func AD(connectionID, fieldKey string) string {
	return "psa-credential:" + connectionID + ":" + fieldKey
}
