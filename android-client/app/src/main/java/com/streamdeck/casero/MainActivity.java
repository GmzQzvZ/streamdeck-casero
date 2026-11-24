package com.streamdeck.casero;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import com.google.zxing.integration.android.IntentIntegrator;
import com.google.zxing.integration.android.IntentResult;

public final class MainActivity extends Activity {
    private static final String PREFERENCES = "stream_deck_settings";
    private static final String SERVER_URL = "server_url";
    private static final int FILE_CHOOSER_REQUEST = 4102;
    private static final int CAMERA_PERMISSION_REQUEST = 4103;
    private static final int BACKGROUND = Color.rgb(17, 18, 22);
    private static final int PANEL = Color.rgb(27, 28, 34);
    private static final int TEXT = Color.rgb(244, 245, 251);
    private static final int MUTED = Color.rgb(174, 177, 189);
    private static final int PURPLE = Color.rgb(185, 173, 255);

    private WebView webView;
    private LinearLayout connectionPanel;
    private EditText urlInput;
    private TextView message;
    private Uri connectedUri;
    private ValueCallback<Uri[]> filePathCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(BACKGROUND);
        getWindow().setNavigationBarColor(BACKGROUND);
        getWindow().setFlags(
                WindowManager.LayoutParams.FLAG_FULLSCREEN,
                WindowManager.LayoutParams.FLAG_FULLSCREEN
        );

        FrameLayout root = new FrameLayout(this);
        webView = new WebView(this);
        webView.setBackgroundColor(BACKGROUND);
        configureWebView();
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));

        connectionPanel = buildConnectionPanel();
        root.addView(connectionPanel, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));
        setContentView(root);

        String savedUrl = getSharedPreferences(PREFERENCES, MODE_PRIVATE).getString(SERVER_URL, "");
        urlInput.setText(savedUrl);
        if (savedUrl.isEmpty()) {
            showConnectionPanel();
        } else {
            connectTo(savedUrl);
        }
    }

    // The local panel needs JavaScript; WebView navigation stays on the selected server origin.
    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri target = request.getUrl();
                if (connectedUri != null &&
                        connectedUri.getScheme().equalsIgnoreCase(target.getScheme()) &&
                        connectedUri.getHost().equalsIgnoreCase(target.getHost()) &&
                        effectivePort(connectedUri) == effectivePort(target)) {
                    return false;
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    runOnUiThread(() -> {
                        message.setText(R.string.connection_failed);
                        showConnectionPanel();
                    });
                }
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(
                    WebView view,
                    ValueCallback<Uri[]> callback,
                    FileChooserParams fileChooserParams
            ) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;
                try {
                    startActivityForResult(fileChooserParams.createIntent(), FILE_CHOOSER_REQUEST);
                    return true;
                } catch (Exception error) {
                    filePathCallback = null;
                    callback.onReceiveValue(null);
                    message.setText(R.string.file_picker_failed);
                    showConnectionPanel();
                    return false;
                }
            }
        });
    }

    private LinearLayout buildConnectionPanel() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        panel.setPadding(dp(24), dp(24), dp(24), dp(24));
        panel.setBackgroundColor(BACKGROUND);

        ScrollView scroll = new ScrollView(this);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setGravity(Gravity.CENTER_HORIZONTAL);
        content.setPadding(dp(8), dp(12), dp(8), dp(12));

        TextView title = new TextView(this);
        title.setText(R.string.connection_title);
        title.setTextColor(TEXT);
        title.setTextSize(25);
        title.setGravity(Gravity.CENTER);
        content.addView(title, matchWrap());

        TextView instructions = new TextView(this);
        instructions.setText(R.string.connection_instructions);
        instructions.setTextColor(MUTED);
        instructions.setTextSize(14);
        instructions.setGravity(Gravity.CENTER);
        addVerticalSpace(content, 12);
        content.addView(instructions, matchWrap());

        urlInput = new EditText(this);
        urlInput.setSingleLine(true);
        urlInput.setInputType(
                android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI
        );
        urlInput.setHint(R.string.url_hint);
        urlInput.setHintTextColor(MUTED);
        urlInput.setTextColor(TEXT);
        urlInput.setTextSize(16);
        urlInput.setPadding(dp(12), dp(10), dp(12), dp(10));
        urlInput.setBackgroundColor(PANEL);
        addVerticalSpace(content, 18);
        content.addView(urlInput, matchWrap());

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.CENTER);
        Button connectButton = makeButton(getString(R.string.connect));
        Button scanButton = makeButton(getString(R.string.scan_qr));
        LinearLayout.LayoutParams actionParams = new LinearLayout.LayoutParams(0, dp(48), 1);
        actionParams.setMargins(0, dp(14), dp(6), 0);
        actions.addView(connectButton, actionParams);
        LinearLayout.LayoutParams scanParams = new LinearLayout.LayoutParams(0, dp(48), 1);
        scanParams.setMargins(dp(6), dp(14), 0, 0);
        actions.addView(scanButton, scanParams);
        content.addView(actions, matchWrap());

        message = new TextView(this);
        message.setTextColor(MUTED);
        message.setTextSize(13);
        message.setGravity(Gravity.CENTER);
        addVerticalSpace(content, 12);
        content.addView(message, matchWrap());

        connectButton.setOnClickListener(view -> connectTo(urlInput.getText().toString()));
        scanButton.setOnClickListener(view -> scanQrCode());
        scroll.addView(content);
        panel.addView(scroll, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));
        return panel;
    }

    private Button makeButton(String label) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextColor(BACKGROUND);
        button.setTextSize(13);
        button.setAllCaps(false);
        button.setBackgroundTintList(android.content.res.ColorStateList.valueOf(PURPLE));
        return button;
    }

    private LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
    }

    private void addVerticalSpace(LinearLayout parent, int sizeDp) {
        View space = new View(this);
        parent.addView(space, new LinearLayout.LayoutParams(1, dp(sizeDp)));
    }

    private void scanQrCode() {
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_PERMISSION_REQUEST);
            return;
        }
        startQrScanner();
    }

    private void startQrScanner() {
        IntentIntegrator scanner = new IntentIntegrator(this);
        scanner.setDesiredBarcodeFormats(IntentIntegrator.QR_CODE);
        scanner.setPrompt(getString(R.string.scan_prompt));
        scanner.setBeepEnabled(false);
        scanner.setOrientationLocked(false);
        scanner.initiateScan();
    }

    private void connectTo(String input) {
        try {
            String url = normalizeServerUrl(input);
            connectedUri = Uri.parse(url);
            urlInput.setText(url);
            message.setText("");
            getSharedPreferences(PREFERENCES, MODE_PRIVATE)
                    .edit()
                    .putString(SERVER_URL, url)
                    .apply();
            connectionPanel.setVisibility(View.GONE);
            webView.setVisibility(View.VISIBLE);
            webView.loadUrl(url);
        } catch (IllegalArgumentException error) {
            message.setText(error.getMessage());
            showConnectionPanel();
        }
    }

    private String normalizeServerUrl(String input) {
        String value = input == null ? "" : input.trim();
        if (value.isEmpty()) throw new IllegalArgumentException(getString(R.string.url_empty));
        if (!value.matches("(?i)^https?://.*")) value = "http://" + value;

        Uri uri = Uri.parse(value);
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (scheme == null || host == null ||
                !(scheme.equalsIgnoreCase("http") || scheme.equalsIgnoreCase("https")) ||
                (uri.getEncodedAuthority() != null && uri.getEncodedAuthority().contains("@")) ||
                uri.getPort() == 0 || uri.getPort() > 65535) {
            throw new IllegalArgumentException(getString(R.string.url_invalid));
        }
        return uri.buildUpon().fragment(null).build().toString();
    }

    private int effectivePort(Uri uri) {
        if (uri.getPort() != -1) return uri.getPort();
        return "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
    }

    private void showConnectionPanel() {
        webView.setVisibility(View.GONE);
        connectionPanel.setVisibility(View.VISIBLE);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST) {
            if (filePathCallback != null) {
                Uri[] results = null;
                if (resultCode == RESULT_OK && data != null) {
                    ClipData clipData = data.getClipData();
                    if (clipData != null) {
                        results = new Uri[clipData.getItemCount()];
                        for (int i = 0; i < clipData.getItemCount(); i++) {
                            results[i] = clipData.getItemAt(i).getUri();
                        }
                    } else if (data.getData() != null) {
                        results = new Uri[]{data.getData()};
                    }
                }
                filePathCallback.onReceiveValue(results);
                filePathCallback = null;
            }
            return;
        }

        IntentResult scanResult = IntentIntegrator.parseActivityResult(requestCode, resultCode, data);
        if (scanResult != null) {
            if (scanResult.getContents() != null) {
                connectTo(scanResult.getContents());
            } else {
                message.setText(R.string.qr_empty);
                showConnectionPanel();
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == CAMERA_PERMISSION_REQUEST) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                startQrScanner();
            } else {
                message.setText(R.string.camera_permission_denied);
                showConnectionPanel();
            }
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (connectionPanel.getVisibility() == View.VISIBLE) {
            super.onBackPressed();
        } else if (webView.canGoBack()) {
            webView.goBack();
        } else {
            message.setText(R.string.change_server);
            showConnectionPanel();
        }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
