// AST Tube for Android: a watch-only YouTube frontend.
//
// Everything runs on the phone:
//  - LocalServer serves the bundled HTML/CSS/JS UI on 127.0.0.1 and answers /api/...
//  - YouTube.kt (NewPipeExtractor) fetches the actual data from YouTube.
//  - This file shows the UI in a full-screen WebView.

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

import 'local_server.dart';

const bg = Color(0xFF0B0A12);
const purple = Color(0xFF8B3DFF);
const barStyle = SystemUiOverlayStyle(
  statusBarColor: bg,
  statusBarIconBrightness: Brightness.light,
  systemNavigationBarColor: bg,
  systemNavigationBarIconBrightness: Brightness.light,
);

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(barStyle);
  runApp(MaterialApp(
    title: 'AST Tube',
    debugShowCheckedModeBanner: false,
    theme: ThemeData(brightness: Brightness.dark, scaffoldBackgroundColor: bg, colorSchemeSeed: purple),
    home: const Shell(),
  ));
}

class Shell extends StatefulWidget {
  const Shell({super.key});

  @override
  State<Shell> createState() => _ShellState();
}

class _ShellState extends State<Shell> {
  static const _media = MethodChannel('asttube/media');
  static const _net = MethodChannel('asttube/net');
  final _server = LocalServer();
  final _web = WebViewController();
  bool _loading = true;
  String? _error;
  Widget? _fullscreen; // video player shown fullscreen by the page
  late final AppLifecycleListener _lifecycle;

  @override
  void initState() {
    super.initState();
    // Notification / headset buttons -> the page's player.
    _media.setMethodCallHandler((call) async {
      if (call.method == 'action') {
        await _web.runJavaScript('window.astMedia && window.astMedia(${jsonEncode(call.arguments)})');
      }
    });
    // Internet on/off from Android -> the server (answers fast when offline) and the page.
    _net.setMethodCallHandler((call) async {
      if (call.method == 'changed') {
        _server.online = call.arguments == true;
        _server.metered = await _net.invokeMethod<bool>('metered') ?? true;
        _server.networkChanged();
        await _web.runJavaScript('window.astNet && window.astNet(${_server.online})');
      }
    });
    // Leaving the app: keep playing only if background play is on.
    _lifecycle = AppLifecycleListener(onHide: () {
      if (_server.settings['background'] != true) {
        _web.runJavaScript("window.astMedia && window.astMedia('pause')");
      }
    });
    _start();
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    super.dispose();
  }

  // Messages from the page: {"type":"media","state":{...}} or {"type":"mediaStop"}.
  void _fromPage(JavaScriptMessage msg) {
    final m = jsonDecode(msg.message) as Map<String, dynamic>;
    if (m['type'] == 'media') _media.invokeMethod('update', jsonEncode(m['state']));
    if (m['type'] == 'mediaStop') _media.invokeMethod('stop');
  }

  Future<void> _start() async {
    try {
      _server.online = await _net.invokeMethod<bool>('online') ?? true;
      _server.metered = await _net.invokeMethod<bool>('metered') ?? true;
      _server.version = await _net.invokeMethod<String>('version') ?? '';
      await _server.start();
    } catch (e) {
      setState(() => _error = '$e');
      return;
    }
    _web
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(bg)
      ..addJavaScriptChannel('AstNative', onMessageReceived: _fromPage)
      ..setNavigationDelegate(NavigationDelegate(
        onPageFinished: (_) => setState(() => _loading = false),
        // Links that leave the app (e.g. "Open on YouTube") open outside it.
        onNavigationRequest: (req) {
          final u = Uri.tryParse(req.url);
          if (req.isMainFrame && u != null && u.host != '127.0.0.1' && u.scheme.startsWith('http')) {
            launchUrl(u, mode: LaunchMode.externalApplication);
            return NavigationDecision.prevent;
          }
          return NavigationDecision.navigate;
        },
      ));
    final ua = await _web.getUserAgent();
    await _web.setUserAgent('${ua ?? ''} ASTTubeApp');
    final android = _web.platform;
    if (android is AndroidWebViewController) {
      // Lets chrome://inspect attach to the page while developing.
      if (kDebugMode) await AndroidWebViewController.enableDebugging(true);
      await android.setMediaPlaybackRequiresUserGesture(false);
      await android.setCustomWidgetCallbacks(
        onShowCustomWidget: (widget, hidden) {
          SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
          SystemChrome.setPreferredOrientations([DeviceOrientation.landscapeLeft, DeviceOrientation.landscapeRight]);
          setState(() => _fullscreen = widget);
        },
        onHideCustomWidget: _exitFullscreen,
      );
    }
    await _web.loadRequest(Uri.parse(_server.origin));
  }

  void _exitFullscreen() {
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
    SystemChrome.setPreferredOrientations([]);
    SystemChrome.setSystemUIOverlayStyle(barStyle);
    setState(() => _fullscreen = null);
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        if (_fullscreen != null) {
          await _web.runJavaScript('document.exitFullscreen && document.exitFullscreen()');
          _exitFullscreen();
          return;
        }
        // Let the page close an open sheet/menu first; it answers "handled" if it did.
        final handled = await _web.runJavaScriptReturningResult('window.astBack ? window.astBack() : false');
        if (handled == true || handled.toString() == 'true') return;
        if (await _web.canGoBack()) {
          await _web.goBack();
        } else {
          SystemNavigator.pop();
        }
      },
      child: Scaffold(
        backgroundColor: _fullscreen != null ? Colors.black : bg,
        body: _fullscreen ??
            SafeArea(
              child: Stack(children: [
                if (_error == null) WebViewWidget(controller: _web),
                if (_loading && _error == null)
                  const ColoredBox(color: bg, child: Center(child: CircularProgressIndicator(color: purple))),
                if (_error != null)
                  Center(child: Padding(padding: const EdgeInsets.all(28), child: Text('Could not start: $_error'))),
              ]),
            ),
      ),
    );
  }
}
