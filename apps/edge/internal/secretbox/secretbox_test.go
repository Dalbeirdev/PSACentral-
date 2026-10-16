package secretbox

import (
	"bytes"
	"testing"
)

func TestSealOpenAndBinding(t *testing.T) {
	key := bytes.Repeat([]byte{7}, 32)
	b, err := New(key)
	if err != nil {
		t.Fatal(err)
	}
	ct, nonce, err := b.Seal([]byte("api-secret-value"), AD("conn-1", "secret"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(ct, []byte("api-secret-value")) || len(nonce) != 12 {
		t.Fatal("ciphertext must not contain the plaintext; nonce must be 12 bytes")
	}
	pt, err := b.Open(ct, nonce, AD("conn-1", "secret"))
	if err != nil || string(pt) != "api-secret-value" {
		t.Fatalf("round trip failed: %v", err)
	}
	if _, err := b.Open(ct, nonce, AD("conn-2", "secret")); err == nil {
		t.Fatal("a ciphertext moved to another connection must not decrypt")
	}
	other, _ := New(bytes.Repeat([]byte{8}, 32))
	if _, err := other.Open(ct, nonce, AD("conn-1", "secret")); err == nil {
		t.Fatal("another host's key must not decrypt")
	}
	ct[0] ^= 1
	if _, err := b.Open(ct, nonce, AD("conn-1", "secret")); err == nil {
		t.Fatal("tampering must be detected")
	}
	if _, err := New(make([]byte, 16)); err == nil {
		t.Fatal("16-byte keys must be rejected")
	}
	_, n2, _ := b.Seal([]byte("x"), "ad")
	_, n3, _ := b.Seal([]byte("x"), "ad")
	if bytes.Equal(n2, n3) {
		t.Fatal("nonces must be random")
	}
}
