// V7 manual rover. No arming or maximum hold time. Release/heartbeat stops jogging.
// Wheel PWM25/26 left,32/33 right. Servo19 pan,18 lift. EN hardware HIGH.
// Motors externally powered; ESP32 USB. Common grounds. Never feed battery to logic.
// Servo positions are commanded estimates, NOT measured. First activation may jump.
// Servo PWM holds last target after release/link loss; support arm before OFF/power cut.
#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <esp_system.h>
#include "ManualControl.h"
#include "Dashboard.h"
WebServer web(80);
portMUX_TYPE mux=portMUX_INITIALIZER_UNLOCKED;
Manual::State control;
constexpr uint8_t wheelPins[4]={25,26,32,33},servoPins[2]={19,18};
bool wheelReady=false,servoAttached[2]={false,false};
bool requestOff=false;
int outputDuty[4]={0,0,0,0};
char serialLine[48];size_t serialUsed=0;

bool number(const char *key,long &n){
 const String s=web.arg(key);if(!s.length()||s.length()>11)return false;
 char *end=nullptr;n=strtol(s.c_str(),&end,10);return end!=s.c_str()&&!*end;
}
void stopMotion(){portENTER_CRITICAL(&mux);control.stop();portEXIT_CRITICAL(&mux);}
void webTask(void*){for(;;){web.handleClient();vTaskDelay(pdMS_TO_TICKS(2));}}
void initWeb(){
 WiFi.mode(WIFI_AP);
 if(!WiFi.softAP("Leaf-Rover","leafrover",1,false,1)){Serial.println("WiFi AP failed");return;}
 web.on("/",HTTP_GET,[]{web.sendHeader("Cache-Control","no-store");web.send_P(200,"text/html",dashboard);});
 web.on("/session",HTTP_POST,[]{
   const uint32_t key=(esp_random()&0x3fffffff)+1;
   portENTER_CRITICAL(&mux);control.session(key,millis());portEXIT_CRITICAL(&mux);
   char b[64];snprintf(b,sizeof(b),"{\"token\":%lu}",(unsigned long)key);web.send(200,"application/json",b);
 });
 web.on("/control",HTTP_POST,[]{
   long token,seq,w,p,l,wp,sp;
   if(!number("token",token)||!number("seq",seq)||!number("wheel",w)||!number("pan",p)||!number("lift",l)||!number("power",wp)||!number("speed",sp)||token<=0||seq<=0){
     web.send(400,"text/plain","Invalid command");return;
   }
   portENTER_CRITICAL(&mux);
   const bool ok=wheelReady&&control.accept(token,seq,w,p,l,wp,sp,millis());
   portEXIT_CRITICAL(&mux);
   web.send(ok?200:409,ok?"application/json":"text/plain",ok?"{}":"Stale session or invalid command");
 });
 web.on("/status",HTTP_GET,[]{
   portENTER_CRITICAL(&mux);const Manual::State s=control;
   const bool ready=wheelReady;
   const int a=outputDuty[0],b=outputDuty[1],c=outputDuty[2],d=outputDuty[3];
   portEXIT_CRITICAL(&mux);
   char out[220];snprintf(out,sizeof(out),"{\"ready\":%s,\"sequence\":%lu,\"pan\":%d,\"lift\":%d,\"pwm\":[%d,%d,%d,%d]}",ready?"true":"false",(unsigned long)s.sequence,s.position[0],s.position[1],a,b,c,d);
   web.sendHeader("Cache-Control","no-store");web.send(200,"application/json",out);
 });
 web.begin();
 if(xTaskCreatePinnedToCore(webTask,"rover-http",6144,nullptr,1,nullptr,0)!=pdPASS){web.stop();WiFi.softAPdisconnect(true);Serial.println("Web task failed");return;}
 Serial.println("WIFI: Leaf-Rover | PASSWORD: leafrover | http://192.168.4.1");
}
void status(){
 portENTER_CRITICAL(&mux);const Manual::State s=control;
 const int a=outputDuty[0],b=outputDuty[1],c=outputDuty[2],d=outputDuty[3];portEXIT_CRITICAL(&mux);
 Serial.printf("V7 | wheelPWM25/26=%d/%d right32/33=%d/%d | PAN%dus LIFT%dus | wheels0..100%%; no arm/no hold limit; heartbeat500ms\n",a,b,c,d,s.position[0],s.position[1]);
}
void command(const char *s){
 if(!strcmp(s,"STOP")){stopMotion();Serial.println("Motion stopped; enabled servos hold last target.");}
 else if(!strcmp(s,"OFF")){stopMotion();requestOff=true;Serial.println("Servo signals OFF requested: support arm.");}
 else if(!strcmp(s,"WIFI"))Serial.println("WIFI: Leaf-Rover | PASSWORD: leafrover | http://192.168.4.1");
 else if(!strcmp(s,"STATUS"))status();
 else Serial.println("Use dashboard. Serial: STOP, OFF, STATUS, WIFI. Old DRIVE ARM commands removed.");
}
void setup(){
 Serial.begin(115200);
 bool ok=true;
 for(int i=0;i<4;++i){pinMode(wheelPins[i],OUTPUT);digitalWrite(wheelPins[i],LOW);if(!ledcAttachChannel(wheelPins[i],20000,8,i))ok=false;else ledcWrite(wheelPins[i],0);}
 for(auto pin:servoPins){pinMode(pin,OUTPUT);digitalWrite(pin,LOW);}
 wheelReady=ok;control.lastTick=millis();
 Serial.println("ROVER_WIFI_V7 | boot wheelPWM0, servo signals OFF");
 if(!ok)Serial.println("Wheel PWM fault: disconnect battery");
 initWeb();status();
}
void loop(){
 for(int n=0;n<32&&Serial.available();++n){const char c=Serial.read();if(c=='\n'||c=='\r'){if(serialUsed){serialLine[serialUsed]=0;command(serialLine);}serialUsed=0;}else if(c>=32&&c<=126&&serialUsed<sizeof(serialLine)-1)serialLine[serialUsed++]=c;else{serialUsed=0;stopMotion();}}
 const uint32_t now=millis();
 if(requestOff){
   for(int i=0;i<2;++i){if(servoAttached[i])ledcDetach(servoPins[i]);servoAttached[i]=false;digitalWrite(servoPins[i],LOW);}
   portENTER_CRITICAL(&mux);control.enabled[0]=control.enabled[1]=false;portEXIT_CRITICAL(&mux);requestOff=false;
 }
 portENTER_CRITICAL(&mux);control.tick(now);const Manual::State s=control;portEXIT_CRITICAL(&mux);
 int left,right;s.targets(left,right);
 const int signedDuty[2]={wheelReady?Manual::duty(left):0,wheelReady?Manual::duty(right):0};
 int duties[4]={0,0,0,0};bool ok=true;
 if(wheelReady)for(int i=0;i<2;++i){
   const int d=signedDuty[i];const int positive=d>0?d:0,negative=d<0?-d:0;
   // Clear inactive direction FIRST; never leave old reverse PWM asserted.
   if(d>=0){ok=ledcWrite(wheelPins[i*2+1],0)&&ok;ok=ledcWrite(wheelPins[i*2],positive)&&ok;}
   else{ok=ledcWrite(wheelPins[i*2],0)&&ok;ok=ledcWrite(wheelPins[i*2+1],negative)&&ok;}
   duties[i*2]=positive;duties[i*2+1]=negative;
 }
 if(!ok){for(auto pin:wheelPins)ledcWrite(pin,0);stopMotion();portENTER_CRITICAL(&mux);wheelReady=false;portEXIT_CRITICAL(&mux);Serial.println("PWM fault: disconnect battery");}
 portENTER_CRITICAL(&mux);for(int i=0;i<4;++i)outputDuty[i]=ok?duties[i]:0;portEXIT_CRITICAL(&mux);
 for(int i=0;i<2;++i){
   if(!s.enabled[i])continue;
   if(!servoAttached[i]){
     servoAttached[i]=ledcAttachChannel(servoPins[i],50,16,4+i*2);
     if(!servoAttached[i]){stopMotion();Serial.println("Servo PWM attach failed");continue;}
   }
   const uint32_t duty=(uint64_t(s.position[i])*65536+10000)/20000;
   if(!ledcWrite(servoPins[i],duty)){stopMotion();Serial.println("Servo PWM failure");}
 }
 delay(2);
}
