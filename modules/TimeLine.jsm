/*
 * This Source Code is subject to the terms of the Mozilla Public License
 * version 2.0 (the "License"). You can obtain a copy of the License at
 * http://mozilla.org/MPL/2.0/.
 */

/**
 * @fileOverview Debugging module used for load time measurements.
 */

var EXPORTED_SYMBOLS = ["TimeLine"];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

let nestingCounter = 0;
let firstTimeStamp = null;
let lastTimeStamp = null;

let asyncActions = {__proto__: null};

/**
 * Time logging module, used to measure startup time of Adblock Plus (development builds only).
 * @class
 */
var TimeLine = {
	/**
	 * Logs an event to console together with the time it took to get there.
	 */
	log: function(/**String*/ message, /**Boolean*/ _forceDisplay)
	{
		if (!_forceDisplay && nestingCounter <= 0)
			return;

		let now = Date.now();
		let diff = lastTimeStamp ? Math.round(now - lastTimeStamp) : "first event";
		lastTimeStamp = now;

		// Indent message depending on current nesting level
		for (let i = 0; i < nestingCounter; i++)
			message = "* " + message;

		// Pad message with spaces
		let padding = [];
		for (let i = message.toString().length; i < 80; i++)
			padding.push(" ");
		dump("[" + now + "] ABP timeline: " + message + padding.join("") + "\t (" + diff + ")\n");
	},

	/**
	 * Called to indicate that application entered a block that needs to be timed.
	 */
	enter: function(/**String*/ message)
	{
		if (nestingCounter <= 0)
			firstTimeStamp = Date.now();

		this.log(message, true);
		nestingCounter = (nestingCounter <= 0 ? 1 : nestingCounter + 1);
	},

	/**
	 * Called when application exited a block that TimeLine.enter() was called for.
	 * @param {String} message  message to be logged
	 * @param {String} [asyncAction]  identifier of a pending async action
	 */
	leave: function(message, asyncAction)
	{
		if (typeof asyncAction != "undefined")
			message += " (async action pending)";

		nestingCounter--;
		this.log(message, true);

		if (nestingCounter <= 0)
		{
			if (firstTimeStamp !== null)
				dump("ABP timeline: Total time elapsed: " + Math.round(Date.now() - firstTimeStamp) + "\n");
			firstTimeStamp = null;
			lastTimeStamp = null;
		}

		if (typeof asyncAction != "undefined")
		{
			if (asyncAction in asyncActions)
				dump("ABP timeline: Warning: Async action " + asyncAction + " already executing\n");
			asyncActions[asyncAction] = {start: Date.now(), total: 0};
		}
	},

	/**
	 * Called when the application starts processing of an async action.
	 */
	asyncStart: function(/**String*/ asyncAction)
	{
		if (asyncAction in asyncActions)
		{
			let action = asyncActions[asyncAction];
			if ("currentStart" in action)
				dump("ABP timeline: Warning: Processing reentered for async action " + asyncAction + "\n");
			action.currentStart = Date.now();
		}
		else
			dump("ABP timeline: Warning: Async action " + asyncAction + " is unknown\n");
	},

	/**
	 * Called when the application finishes processing of an async action.
	 */
	asyncEnd: function(/**String*/ asyncAction)
	{
		if (asyncAction in asyncActions)
		{
			let action = asyncActions[asyncAction];
			if ("currentStart" in action)
			{
				action.total += Date.now() - action.currentStart;
				delete action.currentStart;
			}
			else
				dump("ABP timeline: Warning: Processing not entered for async action " + asyncAction + "\n");
		}
		else
			dump("ABP timeline: Warning: Async action " + asyncAction + " is unknown\n");
	},

	/**
	 * Called when an async action is done and its time can be logged.
	 */
	asyncDone: function(/**String*/ asyncAction)
	{
		if (asyncAction in asyncActions)
		{
			let action = asyncActions[asyncAction];
			let now = Date.now();
			let diff = now - action.start;
			if ("currentStart" in action)
				dump("ABP timeline: Warning: Still processing for async action " + asyncAction + "\n");

			let message = "Async action " + asyncAction + " done";
			let padding = [];
			for (let i = message.toString().length; i < 80; i++)
				padding.push(" ");
			dump("[" + now + "] ABP timeline: " + message + padding.join("") + "\t (" + action.total + "/" + diff + ")\n");
		}
		else
			dump("ABP timeline: Warning: Async action " + asyncAction + " is unknown\n");
	}
};
