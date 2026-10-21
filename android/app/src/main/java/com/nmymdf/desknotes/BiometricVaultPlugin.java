package com.nmymdf.desknotes;

import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * 指紋解鎖 for 上鎖筆記. The vault password is encrypted with a key kept in the
 * phone's secure hardware (Android Keystore). That key can only be used right
 * after a fingerprint check, and it is destroyed when fingerprints are added or
 * removed. The app itself never stores the password in readable form.
 */
@CapacitorPlugin(name = "BiometricVault")
public class BiometricVaultPlugin extends Plugin {

    private static final String KEY_NAME = "desknotes_vault_key";
    private static final int STRONG = BiometricManager.Authenticators.BIOMETRIC_STRONG;

    private interface CipherAction {
        void run(Cipher cipher) throws Exception;
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        int status = BiometricManager.from(getContext()).canAuthenticate(STRONG);
        JSObject ret = new JSObject();
        ret.put("available", status == BiometricManager.BIOMETRIC_SUCCESS);
        ret.put("status", status);
        call.resolve(ret);
    }

    /** Encrypt `secret` behind a fingerprint check; returns { data, iv } (safe to store). */
    @PluginMethod
    public void enable(PluginCall call) {
        String secret = call.getString("secret");
        if (secret == null) {
            call.reject("missing secret");
            return;
        }
        try {
            deleteKey();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, getKey(true));
            prompt(call, cipher, "開啟指紋解鎖", (Cipher ok) -> {
                byte[] data = ok.doFinal(secret.getBytes(StandardCharsets.UTF_8));
                JSObject ret = new JSObject();
                ret.put("data", Base64.encodeToString(data, Base64.NO_WRAP));
                ret.put("iv", Base64.encodeToString(ok.getIV(), Base64.NO_WRAP));
                call.resolve(ret);
            });
        } catch (Exception e) {
            call.reject(e.getMessage() != null ? e.getMessage() : e.toString(), "error");
        }
    }

    /** Fingerprint check, then decrypt { data, iv } back to the secret. */
    @PluginMethod
    public void unlock(PluginCall call) {
        String data = call.getString("data");
        String iv = call.getString("iv");
        try {
            SecretKey key = getKey(false);
            if (key == null || data == null || iv == null) {
                call.reject("指紋解鎖沒有開啟", "not_enabled");
                return;
            }
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            try {
                cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
            } catch (KeyPermanentlyInvalidatedException e) {
                deleteKey();
                call.reject("手機的指紋有變更", "invalidated");
                return;
            }
            prompt(call, cipher, "解鎖上鎖筆記", (Cipher ok) -> {
                byte[] plain = ok.doFinal(Base64.decode(data, Base64.NO_WRAP));
                JSObject ret = new JSObject();
                ret.put("secret", new String(plain, StandardCharsets.UTF_8));
                call.resolve(ret);
            });
        } catch (Exception e) {
            call.reject(e.getMessage() != null ? e.getMessage() : e.toString(), "error");
        }
    }

    @PluginMethod
    public void disable(PluginCall call) {
        try {
            deleteKey();
        } catch (Exception e) {
            // nothing to remove
        }
        call.resolve();
    }

    private void prompt(PluginCall call, Cipher cipher, String title, CipherAction onSuccess) {
        FragmentActivity activity = getActivity();
        activity.runOnUiThread(() -> {
            BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setSubtitle("DeskNotes")
                .setNegativeButtonText("改用密碼")
                .setAllowedAuthenticators(STRONG)
                .build();
            BiometricPrompt biometricPrompt = new BiometricPrompt(activity, ContextCompat.getMainExecutor(activity),
                new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                        try {
                            BiometricPrompt.CryptoObject crypto = result.getCryptoObject();
                            if (crypto == null || crypto.getCipher() == null) {
                                call.reject("指紋驗證失敗", "error");
                                return;
                            }
                            onSuccess.run(crypto.getCipher());
                        } catch (Exception e) {
                            call.reject(e.getMessage() != null ? e.getMessage() : e.toString(), "error");
                        }
                    }

                    @Override
                    public void onAuthenticationError(int errorCode, CharSequence errString) {
                        call.reject(errString.toString(), "cancel");
                    }
                    // onAuthenticationFailed (a finger that doesn't match): the prompt stays open.
                });
            biometricPrompt.authenticate(info, new BiometricPrompt.CryptoObject(cipher));
        });
    }

    private SecretKey getKey(boolean create) throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_NAME)) return (SecretKey) ks.getKey(KEY_NAME, null);
        if (!create) return null;
        KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(KEY_NAME,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setUserAuthenticationRequired(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) spec.setInvalidatedByBiometricEnrollment(true);
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        gen.init(spec.build());
        return gen.generateKey();
    }

    private void deleteKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_NAME)) ks.deleteEntry(KEY_NAME);
    }
}
