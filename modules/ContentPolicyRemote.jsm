/*
 * This Source Code is subject to the terms of the Mozilla Public License
 * version 2.0 (the "License"). You can obtain a copy of the License at
 * http://mozilla.org/MPL/2.0/.
 */

/**
 * @fileOverview Content policy to be loaded in the content process for a multi-process setup (currently only Fennec)
 */

var EXPORTED_SYMBOLS = ["PolicyRemote"];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("chrome://adblockplus-modules/content/Utils.jsm");

/**
 * nsIContentPolicy and nsIChannelEventSink implementation
 * @class
 */
var PolicyRemote =
{
	classDescription: "Adblock Plus content policy",
	classID: Components.ID("094560a0-4fed-11e0-b8af-0800200c9a66"),
	contractID: "@adblockplus.org/abp/policy-remote;1",
	xpcom_categories: ["content-policy", "net-channel-event-sinks"],

	cache: new Cache(512),

	startup: function()
	{
		let registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
		try
		{
			registrar.registerFactory(PolicyRemote.classID, PolicyRemote.classDescription, PolicyRemote.contractID, PolicyRemote);
		}
		catch (e)
		{
			// Don't stop on errors - the factory might already be registered
			Cu.reportError(e);
		}

		let catMan = Utils.categoryManager;
		for each (let category in PolicyRemote.xpcom_categories)
			catMan.addCategoryEntry(category, PolicyRemote.classDescription, PolicyRemote.contractID, false, true);

		Services.obs.addObserver(PolicyRemote, "http-on-modify-request", true);
		Services.obs.addObserver(PolicyRemote, "content-document-global-created", true);

		// Generate class identifier used to collapse node and register corresponding
		// stylesheet.
		let offset = "a".charCodeAt(0);
		Utils.collapsedClass = "";
		for (let i = 0; i < 20; i++)
			Utils.collapsedClass +=  String.fromCharCode(offset + Math.random() * 26);

		let collapseStyle = Utils.makeURI("data:text/css," +
																			encodeURIComponent("." + Utils.collapsedClass +
																			"{-moz-binding: url(chrome://global/content/bindings/general.xml#foobarbazdummy) !important;}"));
		Utils.styleService.loadAndRegisterSheet(collapseStyle, Ci.nsIStyleSheetService.USER_SHEET);

		// Get notified if we need to invalidate our matching cache
		Utils.childMessageManager.addMessageListener("AdblockPlus:Matcher:clearCache", function(message)
		{
			PolicyRemote.cache.clear();
		});
	},

	//
	// nsISupports interface implementation
	//

	QueryInterface: XPCOMUtils.generateQI([Ci.nsIContentPolicy, Ci.nsIObserver,
		Ci.nsIChannelEventSink, Ci.nsIFactory, Ci.nsISupportsWeakReference]),

	//
	// nsIContentPolicy interface implementation
	//

	shouldLoad: function(contentType, contentLocation, requestOrigin, node, mimeTypeGuess, extra)
	{
		// Ignore requests without context and top-level documents
		if (!node || contentType == Ci.nsIContentPolicy.TYPE_DOCUMENT)
			return Ci.nsIContentPolicy.ACCEPT;

		let wnd = Utils.getWindow(node);
		if (!wnd)
			return Ci.nsIContentPolicy.ACCEPT;

		wnd = Utils.getOriginWindow(wnd);

		let locations = [];
		let testWnd = wnd;
		while (true)
		{
			locations.push(testWnd.location.href);
			if (testWnd.parent == testWnd)
				break;
			else
				testWnd = testWnd.parent;
		}

		let key = contentType + " " + contentLocation.spec + " " + locations.join(" ");
		if (!(key in this.cache.data))
		{
			this.cache.add(key, Utils.childMessageManager.sendSyncMessage("AdblockPlus:Policy:shouldLoad", {
							contentType: contentType,
							contentLocation: contentLocation.spec,
							locations: locations})[0]);
		}

		let result = this.cache.data[key];
		if (result.value == Ci.nsIContentPolicy.ACCEPT)
		{
			// We didn't block this request so we will probably see it again in
			// http-on-modify-request. Keep it so that we can associate it with the
			// channel there - will be needed in case of redirect.
			PolicyRemote.previousRequest = [Utils.unwrapURL(contentLocation), contentType];
		}
		else if (result.postProcess)
			Utils.schedulePostProcess(node);
		return result.value;
	},

	shouldProcess: function(contentType, contentLocation, requestOrigin, insecNode, mimeType, extra)
	{
		return Ci.nsIContentPolicy.ACCEPT;
	},

	//
	// nsIObserver interface implementation
	//
	observe: function(subject, topic, data, additional)
	{
		switch (topic)
		{
			case "content-document-global-created":
			{
				if (!(subject instanceof Ci.nsIDOMWindow) || !subject.opener)
					return;

				let uri = additional || Utils.makeURI(subject.location.href);
				if (PolicyRemote.shouldLoad(0xFFFE /*Policy.type.POPUP*/, uri, null, subject.opener.document, null, null) != Ci.nsIContentPolicy.ACCEPT)
				{
					subject.stop();
					Utils.runAsync(subject.close, subject);
				}
				else if (uri.spec == "about:blank")
				{
					// An about:blank pop-up most likely means that a load will be
					// initiated synchronously. Set a flag for our "http-on-modify-request"
					// handler.
					PolicyRemote.expectingPopupLoad = true;
					Utils.runAsync(function()
					{
						PolicyRemote.expectingPopupLoad = false;
					});
				}

				break;
			}
			case "http-on-modify-request":
			{
				if (!(subject instanceof Ci.nsIHttpChannel))
					return;

				// TODO: Do-not-track header

				if (PolicyRemote.previousRequest && subject.URI == PolicyRemote.previousRequest[0] &&
						subject instanceof Ci.nsIWritablePropertyBag)
				{
					// We just handled a content policy call for this request - associate
					// the data with the channel so that we can find it in case of a redirect.
					subject.setProperty("abpRequestType", PolicyRemote.previousRequest[1]);
					PolicyRemote.previousRequest = null;
				}

				if (PolicyRemote.expectingPopupLoad)
				{
					let wnd = Utils.getRequestWindow(subject);
					if (wnd && wnd.opener && wnd.location.href == "about:blank")
						PolicyRemote.observe(wnd, "content-document-global-created", null, subject.URI);
				}

				break;
			}
		}
	},

	//
	// nsIChannelEventSink interface implementation
	//

	onChannelRedirect: function(oldChannel, newChannel, flags)
	{
		try
		{
			// Try to retrieve previously stored request data from the channel
			let contentType;
			if (oldChannel instanceof Ci.nsIWritablePropertyBag)
			{
				try
				{
					contentType = oldChannel.getProperty("abpRequestType");
				}
				catch(e)
				{
					// No data attached, ignore this redirect
					return;
				}
			}

			let newLocation = null;
			try
			{
				newLocation = newChannel.URI;
			} catch(e2) {}
			if (!newLocation)
				return;

			let wnd = Utils.getRequestWindow(newChannel);
			if (!wnd)
				return;

			// HACK: NS_BINDING_ABORTED would be proper error code to throw but this will show up in error console (bug 287107)
			if (PolicyRemote.shouldLoad(contentType, newLocation, null, wnd.document) != Ci.nsIContentPolicy.ACCEPT)
				throw Cr.NS_BASE_STREAM_WOULD_BLOCK;
			else
				return;
		}
		catch (e if (e != Cr.NS_BASE_STREAM_WOULD_BLOCK))
		{
			// We shouldn't throw exceptions here - this will prevent the redirect.
			Cu.reportError(e);
		}
	},

	asyncOnChannelRedirect: function(oldChannel, newChannel, flags, callback)
	{
		this.onChannelRedirect(oldChannel, newChannel, flags);

		// If onChannelRedirect didn't throw an exception indicate success
		callback.onRedirectVerifyCallback(Cr.NS_OK);
	},

	//
	// nsIFactory interface implementation
	//

	createInstance: function(outer, iid)
	{
		if (outer)
			throw Cr.NS_ERROR_NO_AGGREGATION;
		return this.QueryInterface(iid);
	}
};

PolicyRemote.startup();
