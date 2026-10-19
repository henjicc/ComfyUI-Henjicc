import { icon } from "../asset-card.js";
import { mediaViewUrl } from "../media-viewer.js";

export function cardDetails(item, preferences) {
    const details=[];
    const showName={image:preferences.ShowImageNames,video:preferences.ShowVideoNames,audio:preferences.ShowAudioNames}[item.kind];
    if (showName) details.push({type:"filename",text:preferences.ShowExtensions ? item.name : item.name.replace(/\.[^.]+$/,""),position:preferences.FilenamePosition});
    if (preferences.ShowRatings && item.rating) details.push({type:"rating",text:String(item.rating),position:preferences.RatingPosition});
    if (preferences.ShowTags && item.tags.length) details.push({type:"tags",tags:item.tags,position:preferences.TagsPosition});
    return details;
}

export function appendCardDetails(card, frame, item, preferences) {
    const groups=new Map();
    for (const detail of cardDetails(item,preferences)) {
        if (!groups.has(detail.position)) {
            const group=document.createElement("div"); group.className="card-details";
            group.dataset.position=detail.position;
            (detail.position === "Below thumbnail" ? card : frame).append(group); groups.set(detail.position,group);
        }
        const content=document.createElement("div"); content.className=`card-${detail.type}`;
        if (detail.type === "tags") {
            for (const tag of detail.tags) { const chip=document.createElement("span");chip.textContent=tag;content.append(chip); }
        } else {
            if (detail.type === "rating") content.append(icon("star"));
            content.append(document.createTextNode(detail.text));
        }
        groups.get(detail.position).append(content);
    }
}

export class HoverPlayer {
    constructor({api,t,onError}) { Object.assign(this,{api,t,onError}); }
    schedule(item,frame,source) {
        this.stop();
        this.timer=setTimeout(()=>this.play(item,frame,source),250);
    }
    async play(item,frame,source) {
        if (!frame.isConnected) return;
        const media=document.createElement(item.kind);
        this.media=media; this.frame=frame;
        media.className="hover-media";media.preload="none";media.loop=true;
        media.muted=item.kind === "video";media.playsInline=true;
        media.setAttribute("aria-hidden","true");
        media.addEventListener("playing",()=>{if(this.media===media) frame.dataset.playing="true";});
        media.addEventListener("error",()=>{if(this.media===media){this.stop();this.onError(this.t("素材缺失或浏览器无法预览"));}});
        media.src=mediaViewUrl(this.api,item.path,source);frame.append(media);
        try { await media.play(); }
        catch(error) {
            if(this.media!==media) return;
            this.stop();this.onError(this.t(error.name === "NotAllowedError" ? "浏览器阻止自动播放，请双击预览" : "素材缺失或浏览器无法预览"));
        }
    }
    stop() {
        clearTimeout(this.timer);
        if(this.media) {
            const media=this.media,frame=this.frame;this.media=null;this.frame=null;
            delete frame.dataset.playing;
            media.pause();media.removeAttribute("src");media.load();media.remove();
        }
    }
}
