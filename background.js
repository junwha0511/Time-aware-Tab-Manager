'use strict';

const DEBUG = false;
const MIN_TO_MS = DEBUG ? 1000 : 60 * 1000;
const TIMEOUT = 100;
const MAX_TRIAL = 5;
const ALARM_INTERVAL = 1;
const INIT_THRESHOLD = [15, 60];
const SKIP_THRESHOLD = 2000;

const TAB_LIST_KEY = "__tab_list";

function getUnixTime() {
    return Math.floor(new Date().getTime());
}

function initTabEntry(id, active=false, lastActivatedTime=-1, lastDeactivatedTime=-1, isWhiteList=false){
    return {"id": id, "active": active, "lastActivatedTime": lastActivatedTime == -1 ? getUnixTime(): lastActivatedTime, "lastDeactivatedTime": lastDeactivatedTime == -1 ? getUnixTime():lastDeactivatedTime, "isWhiteList": isWhiteList};
}

function initExtension() {
    chrome.tabs.query({}).then((tabs) => {
        var tabInfoList = []
        for (var tab of tabs) {
            tabInfoList.push(initTabEntry(tab.id));
        }
        StorageManager.setTabInfoListAndThresholds(tabInfoList, INIT_THRESHOLD, ()=>{
                console.log("[DEBUG] Initialized"); 
                TabManager.regroup();
        });
    });
}

// Return two tab lists satisfying thresholds
function getTabListsByTime(callback) {
    chrome.tabs.query({}, (tabs) => {
        StorageManager.getTabInfoListAndThresholds((tabInfoList, THRESHOLD)=>{
            console.log(tabInfoList);
            let firstStage = [];
            let secondStage = [];

            for (var tab of tabs){
                // console.log(tab);
                if (tab.active || tab.isWhiteList) continue;

                // Compare tab's idle time and threshold
                let tabInfo = tabInfoList.filter(info => info["id"] == tab.id)[0]; // TODO: deal with no info (tracking failed scenario)
                if (tabInfo === undefined) console.log("[DEBUG] undefined tabInfo error");
                if (tabInfo["active"]) continue;
                let idleTime = getUnixTime() - tabInfo["lastDeactivatedTime"];
                // console.log(tabInfo);
                if (idleTime < THRESHOLD[0] * MIN_TO_MS)
                    continue;
                else if (idleTime < THRESHOLD[1] * MIN_TO_MS)
                    firstStage.push(tab.id);
                else 
                    secondStage.push(tab.id);
            }
            callback(firstStage, secondStage);
        });
    });
}



class StorageManager
{
    static _callbackGet(key, callback){
        chrome.storage.local.get(key, (item) => {
            callback(item[key]);
        });
    }
    
    static _callbackGetTwoKey(keys, callback){
        chrome.storage.local.get(keys, (item) => {
            callback(item[keys[0]], item[keys[1]]);
        });
    }

    static _callbackSet(pair, callback){
        chrome.storage.local.set(pair, callback);
    }

    static getTabInfoList(callback){
        this._callbackGet("__tab_list", callback);
    }

    static setTabInfoList(tabInfoList, callback=()=>{}){
        this._callbackSet({"__tab_list": tabInfoList}, callback);
    }

    static getThresholds(callback){
        this._callbackGet("__tab_thresholds", callback);
    }

    static setThresholds(thresholds, callback=()=>{}){
        this._callbackSet({"__tab_thresholds": thresholds}, callback);
    }

    static setTabInfoListAndThresholds(tabInfoList, thresholds, callback=()=>{}){
        this._callbackSet({"__tab_list": tabInfoList, "__tab_thresholds": thresholds}, callback);
    }

    static getTabInfoListAndThresholds(callback){
        this._callbackGetTwoKey(["__tab_list", "__tab_thresholds"], callback);
    }
}


class TabManager {
    // This function returns two-dimension array,
    // each array is the tabs which are adjacent
    static groupAdjacentTIDs(tabList) {
        if (tabList.length == 0) return [];

        var allList = new Array();

        tabList.sort(function (a, b) {
            return a.index - b.index;
        });

        var lastIndex = tabList[0].index - 1;
        var eachList = new Array();

        for (const tab of tabList) {
            if (tab.index - 1 != lastIndex) {
                allList.push(eachList);
                eachList = new Array();
            }

            eachList.push(tab.id);
            lastIndex = tab.index;
        }

        if (eachList.length != 0) allList.push(eachList);

        return allList;
    }


    // Group all tabs
    static groupTabs(tabIdList, elapsedTime) {
        if (tabIdList.length == 0)
            return;

        var promList = [];

        for (const tid of tabIdList) {
            promList.push(chrome.tabs.get(tid));
        }

        Promise.all(promList).then((tabList) => {
            tabList.sort(function (a, b) {
                return a.windowId - b.windowId;
            });


            var tmpList = [];
            for (let i = 0; i < tabList.length; i++) {
                tmpList.push(tabList[i]);

                if (i == tabList.length - 1 || tabList[i].windowId != tabList[i + 1].windowId) {
                    var allList = this.groupAdjacentTIDs(tmpList);
                    var windowId = tmpList[0].windowId;
                    for (var tab of tmpList) {
                        if (tab.windowId != windowId) console.log("false!!!!!");
                    }

                    if (allList.length == 0) return;

                    for (const tidList of allList) {
                        ChromeTabAPIWrapper.group(tidList, elapsedTime, windowId);
                    }
                    tmpList = [];
                }

            }
        });
    }

    static regroup(){
        console.log("[DEBUG] regroup");
        getTabListsByTime((firstStage, secondStage)=>{            
            chrome.tabs.query({}, (tabs) => {
                StorageManager.getThresholds((THRESHOLD)=>{
                    var tabIdList = [];
                    for (var tab of tabs){
                        if (tab.groupId > 0)
                        tabIdList.push(tab.id);               
                    }

                    if (tabIdList.length != 0){
                        ChromeTabAPIWrapper.ungroup(tabIdList, ()=>{
                            this.groupTabs(firstStage, THRESHOLD[0]);
                            this.groupTabs(secondStage, THRESHOLD[1]);
                        });
                    } else {
                        this.groupTabs(firstStage, THRESHOLD[0]);
                        this.groupTabs(secondStage, THRESHOLD[1]);
                    }
                });
            });
        });
    }
}

class ChromeTabAPIWrapper{
    static async ungroup(tabIdList, callback, trial=1) {
        try {
            console.log(tabIdList);
            if (trial <= MAX_TRIAL) {
                chrome.tabs.ungroup(tabIdList).catch((e) => {
                    setTimeout(
                        () => this.ungroup(tabIdList, callback, trial + 1),
                        TIMEOUT
                    );
                }).then(() => { callback(); });
            }
        } catch {
            console.log("[DEBUG] Promise error on ungroup");
            return;
        }
    }
    
    // Wrapper of chrome.tabs.group
    static async group(tabIdList, elapsedTime, windowId, trial=1) {
        try {
            if (trial <= MAX_TRIAL) {
                chrome.tabs.group({ createProperties: { windowId: windowId }, tabIds: tabIdList }).catch((e) => setTimeout(() => this.group(tabIdList, elapsedTime, windowId, trial + 1), TIMEOUT)).then((gid) => {
                    StorageManager.getThresholds((THRESHOLD) => {
                        if (gid === -1)
                            return;

                        var _color, _timeInfo;

                        if (parseInt(elapsedTime) >= parseInt(THRESHOLD[1])) {
                            _timeInfo = THRESHOLD[1] < 60 ? `${THRESHOLD[1]}m` : `${parseInt(THRESHOLD[1] / 60)}h`;
                            _color = "red";
                        } else if (parseInt(elapsedTime) >= parseInt(THRESHOLD[0])) {
                            _timeInfo = THRESHOLD[0] < 60 ? `${THRESHOLD[0]}m` : `${parseInt(THRESHOLD[0] / 60)}h`;
                            _color = "yellow";
                        } else {
                            return;
                        }
                        
                        var p = chrome.tabGroups.update(gid, {
                            color: _color,
                            title: _timeInfo
                        });

                        p.catch((e) => console.log("[Exception] no group: " + gid));
                    });
                });
            }
        } catch {
            console.log("[DEBUG] Promise error on group");
            return;
        }
    }   

    // Wrapper of chrome.tabs.remove
    static async remove(tabIdList, trial) {
        return chrome.tabs.remove(tabIdList).catch((e) => {
            if (trial <= MAX_TRIAL) {
                setTimeout(
                    () => this.remove(tabIdList, trial + 1),
                    TIMEOUT
                );
            }
        });
    }
}


async function sendFavIcons(sendResponse) {    
    getTabListsByTime(async (firstStage, secondStage)=>{
        var twoLevelIdList = [firstStage, secondStage];
        var prom_lists = [[], []];

        for (var i = 0; i < 2; i++) {
            for (var j = 0; j < twoLevelIdList[i].length; j++) {
                if (j > 8) break;
                prom_lists[i].push(chrome.tabs.get(twoLevelIdList[i][j]));
            }
        }

        var twoLevelFavIcons = [[], []];

        for (var i = 0; i < 2; i++) {
            var tabList = await Promise.all(prom_lists[i]);
            for (var tab of tabList) {
                if (tab.favIconUrl != "") {
                    twoLevelFavIcons[i].push(tab.favIconUrl);
                } else {
                    twoLevelFavIcons[i].push("https://upload.wikimedia.org/wikipedia/commons/thumb/e/e1/Google_Chrome_icon_%28February_2022%29.svg/1920px-Google_Chrome_icon_%28February_2022%29.svg.png");
                }

            }
        }

        console.log("Send response!");
        sendResponse({
            status: twoLevelFavIcons[0].length > 0 || twoLevelFavIcons[1].length > 0,
            tab_info: {
                first: twoLevelFavIcons[0],
                second: twoLevelFavIcons[1]
            }
        });

        TabManager.regroup();
    });
}

function onPopupMessageReceived (request, sender, sendResponse) {
    if (request.type == 0) { // Close tabs
        getTabListsByTime(
            (firstStage, secondStage) => {
                var targetRemoveList = request.level == 0 ? firstStage : secondStage;
                
                ChromeTabAPIWrapper.remove(targetRemoveList, 1);
            }
        );
    } else if (request.type == 1) { // Update thresholds
        StorageManager.setThresholds([request.thresholds[0], request.thresholds[1]], ()=>{
            TabManager.regroup();
        });
    } else if (request.type == 2) {
        sendFavIcons(sendResponse);
        return true;
    } else {
        console.log(request);
        sendResponse({ status: 0 }); // failed
    }

    if (request.type != 2)
        sendResponse({ status: 1 }); // succeed
}


chrome.runtime.onStartup.addListener(initExtension);
chrome.runtime.onInstalled.addListener(initExtension);
chrome.alarms.create(
    "tab_timer",
    { periodInMinutes: ALARM_INTERVAL },
);

// Add tab into list
chrome.tabs.onCreated.addListener(
    (tab) => {
        StorageManager.getTabInfoList((tabInfoList) => {
            var newTabInfoList = tabInfoList;
            newTabInfoList.push(initTabEntry(tab.id));
            console.log(newTabInfoList);
            StorageManager.setTabInfoList(newTabInfoList, ()=>{});
        });
    }
);

// Remove tab info from from list
chrome.tabs.onRemoved.addListener(
    (tabId, info) => {
        StorageManager.getTabInfoList((tabInfoList) => {
            var newTabInfoList = tabInfoList;
            newTabInfoList = newTabInfoList.filter(entry => entry.id != tabId);
            console.log(newTabInfoList);
            StorageManager.setTabInfoList(newTabInfoList);
        })
    }
);

chrome.tabs.onActivated.addListener(
    (activatedTabInfo) => {
        StorageManager.getTabInfoList((tabInfoList)=>{
            var lastActiveTabs = tabInfoList.filter(tabInfo => tabInfo["active"]);
            var newlyActiveTab = tabInfoList.filter(tabInfo => tabInfo["id"] == activatedTabInfo.tabId)[0];
            var normalTabs = tabInfoList.filter(tabInfo => !lastActiveTabs.includes(tabInfo) && tabInfo != newlyActiveTab);
            var currentTime = getUnixTime();

            if (lastActiveTabs === undefined) lastActiveTabs = [];
            if (normalTabs === undefined) normalTabs = [];
            if (newlyActiveTab === undefined) {
                console.log("[DEBUG] error: activated tab is not tracked");
                newlyActiveTab = initTabEntry(activatedTabInfo.tabId, true);
            }

            for (var tabInfo of lastActiveTabs) {
                
                if (currentTime - tabInfo["lastActivatedTime"] > SKIP_THRESHOLD)
                    tabInfo["lastDeactivatedTime"] = currentTime;
                tabInfo["active"] = false;
                normalTabs.push(tabInfo);
            }

            newlyActiveTab["active"] = true;
            newlyActiveTab["lastActivatedTime"] = currentTime;
            normalTabs.push(newlyActiveTab);

            StorageManager.setTabInfoList(normalTabs, ()=>{TabManager.regroup();});
        });
    }   
);

// Periodically update tab groups
chrome.alarms.onAlarm.addListener((alarm) => {
    TabManager.regroup();
});
/// Message passing with popup.js
chrome.runtime.onMessage.addListener(onPopupMessageReceived);